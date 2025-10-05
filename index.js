require('dotenv').config();
const mineflayer = require('mineflayer');
const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const si = require('systeminformation');
const { spawn } = require('child_process');

// Screenshot settings
const SCREENSHOT_INTERVAL = 5000; // Take screenshot every 5 seconds
let screenshotTimer = null;
const SCREENSHOT_PATH = path.join(__dirname, 'public', 'minecraft-view.png');

// --- CONFIGURATION ---
const USE_DMS_FOR_OWNER = false;

// --- DO NOT TOUCH BELOW THIS LINE UNLESS YOU KNOW WHAT YOUR DOING ---
let reconnecting = false;
let bot = null;
let afkIntervalId = null;
let manualStop = false;
let discordClient;
let statusMessage = null;
let connectionAttempts = 0;
let maxConnectionAttempts = Infinity; // Never give up reconnecting
let reconnectDelay = 5000; // Start with shorter delay for faster reconnection
let lastSuccessfulConnection = 0;

// Connection state management to prevent deadlocks
let connectionState = 'idle'; // idle, connecting, online, cleanup, backoff
let reconnectTimer = null;

function setConnectionState(newState) {
    console.log(`[STATE] Connection state: ${connectionState} → ${newState}`);
    connectionState = newState;

    // Clear any existing reconnect timer when changing states
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

let expectedDisconnect = false;
let pendingSayInteraction = null;
let emeraldSequenceTimer = null;

const BALANCE_UPDATE_INTERVAL = 1800000; // 30 minutes to prevent server overload
const AFK_INTERVAL = 180 * 1000; // 3 minutes - even less aggressive
const HEARTBEAT_INTERVAL = 600 * 1000; // 10 minutes - much less frequent

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const DISCORD_OWNER_ID = process.env.DISCORD_OWNER_ID;
const DISCORD_STATUS_CHANNEL_ID = process.env.DISCORD_STATUS_CHANNEL_ID;
const DISCORD_CHAT_RELAY_CHANNEL_ID = process.env.DISCORD_CHAT_RELAY_CHANNEL_ID;
const DISCORD_CHAT_RELAY_CHANNEL_ID_2 = process.env.DISCORD_CHAT_RELAY_CHANNEL_ID_2;
const PARTNER_CHANNEL_ID = process.env.PARTNER_CHANNEL_ID;

// Authorized users who can use bot commands (in addition to owner)
let AUTHORIZED_USERS = [
    DISCORD_OWNER_ID, // Owner is always authorized
];

// File database paths
const USER_MONEY_FILE = path.join(__dirname, 'user_money.json');
const LINKED_USERS_FILE = path.join(__dirname, 'linked_users.json');
const GIVEAWAYS_FILE = path.join(__dirname, 'giveaways.json');
const AUTHORIZED_USERS_FILE = path.join(__dirname, 'authorized_users.json');
const COMMAND_TOGGLES_FILE = path.join(__dirname, 'command_toggles.json');

// Simple money storage (Discord ID -> amount)
let userMoney = new Map();
let linkedUsers = new Map(); // Discord ID -> Minecraft username
let activeGiveaways = new Map(); // Message ID -> giveaway data

// Command toggles (command name -> enabled/disabled)
let commandToggles = new Map([
    ['giveaways', true],
    ['add', true],
    ['reset', true],
    ['payout', true],
    ['coinflip', true],
    ['slots', true]
]);

// Payment tracking for incoming payments
let pendingPayments = new Map(); // username -> amount

// Invite tracking
let inviteCache = new Map(); // Store invites with their use count

function formatNumberShort(num) {
  if (num === undefined || num === null || isNaN(Number(num))) return 'N/A';
  const n = Number(num);
  if (n >= 1e12) return (n / 1e12).toFixed(2).replace(/\.00$/, '') + 't';
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.00$/, '') + 'b';
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.00$/, '') + 'm';
  if (n >= 1e3) return (n / 1e3).toFixed(2).replace(/\.00$/, '') + 'k';
  return Math.floor(n).toString();
}

function formatUptime(totalSeconds) {
    if (isNaN(totalSeconds) || totalSeconds < 0) return "N/A";
    const days = Math.floor(totalSeconds / (3600 * 24)); totalSeconds %= (3600 * 24);
    const hours = Math.floor(totalSeconds / 3600); totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60); const seconds = Math.floor(totalSeconds % 60);
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

function parseMoneyAmount(amountStr) {
  if (amountStr === undefined || amountStr === null) return 0;
  let str = String(amountStr).replace(/,/g, '').toLowerCase().replace(/\s/g, '').replace(/\$/g, '');
  const suffixMultipliers = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
  const match = str.match(/^([\d.]+)([kmbt])?$/);
  if (match) {
    const numberPart = parseFloat(match[1]);
    const suffix = match[2];
    if (isNaN(numberPart)) return 0;
    return numberPart * (suffix ? suffixMultipliers[suffix] : 1);
  }
  const num = parseFloat(str);
  return !isNaN(num) ? num : 0;
}

function loadAuthorizedUsers() {
    try {
        if (fs.existsSync(AUTHORIZED_USERS_FILE)) {
            const data = fs.readFileSync(AUTHORIZED_USERS_FILE, 'utf8');
            const fileData = JSON.parse(data);
            const authorizedFromFile = fileData.users || [];

            // Merge with default authorized users (owner)
            AUTHORIZED_USERS = [DISCORD_OWNER_ID, ...authorizedFromFile];
            console.log(`[DATABASE] Loaded ${authorizedFromFile.length} authorized users from file`);
        } else {
            AUTHORIZED_USERS = [DISCORD_OWNER_ID];
            console.log('[DATABASE] No authorized users file found, using defaults');
            saveAuthorizedUsers();
        }
    } catch (err) {
        console.error('[DATABASE] Error loading authorized users:', err.message);
        AUTHORIZED_USERS = [DISCORD_OWNER_ID];
        saveAuthorizedUsers();
    }
}

function loadCommandToggles() {
    try {
        if (fs.existsSync(COMMAND_TOGGLES_FILE)) {
            const data = fs.readFileSync(COMMAND_TOGGLES_FILE, 'utf8');
            const togglesData = JSON.parse(data);
            commandToggles = new Map(Object.entries(togglesData.toggles || {}));
            console.log(`[DATABASE] Loaded ${commandToggles.size} command toggles from file`);
        } else {
            console.log('[DATABASE] No command toggles file found, using defaults');
            saveCommandToggles();
        }
    } catch (err) {
        console.error('[DATABASE] Error loading command toggles:', err.message);
        saveCommandToggles();
    }
}

function saveCommandToggles() {
    try {
        const togglesData = {
            toggles: Object.fromEntries(commandToggles),
            metadata: {
                version: '1.0',
                lastUpdated: new Date().toISOString()
            }
        };
        fs.writeFileSync(COMMAND_TOGGLES_FILE, JSON.stringify(togglesData, null, 2));
        console.log(`[DATABASE] Saved ${commandToggles.size} command toggles to file`);
    } catch (err) {
        console.error('[DATABASE] Error saving command toggles:', err.message);
    }
}

function isCommandEnabled(commandName) {
    return commandToggles.get(commandName) !== false;
}

function saveAuthorizedUsers() {
    try {
        // Filter out owner ID to avoid duplicates in file
        const usersToSave = AUTHORIZED_USERS.filter(id => id !== DISCORD_OWNER_ID);

        const authorizedUsersData = {
            users: usersToSave,
            metadata: {
                version: '1.0',
                created: new Date().toISOString(),
                lastModified: new Date().toISOString(),
                totalUsers: usersToSave.length
            }
        };
        fs.writeFileSync(AUTHORIZED_USERS_FILE, JSON.stringify(authorizedUsersData, null, 2));
        console.log(`[DATABASE] Saved ${usersToSave.length} authorized users to file`);
    } catch (err) {
        console.error('[DATABASE] Error saving authorized users:', err.message);
    }
}

function isAuthorizedUser(userId) {
  return AUTHORIZED_USERS.includes(userId);
}

// Invite tracking functions
async function updateInviteCache() {
    if (!discordClient || !discordClient.isReady()) return;

    try {
        const guild = discordClient.guilds.cache.get(DISCORD_GUILD_ID);
        if (!guild) return;

        const invites = await guild.invites.fetch();
        inviteCache.clear();

        invites.forEach(invite => {
            inviteCache.set(invite.code, {
                uses: invite.uses || 0,
                inviter: invite.inviter
            });
        });

        console.log(`[INVITES] Updated invite cache with ${invites.size} invites`);
    } catch (err) {
        console.error('[INVITES] Error updating invite cache:', err.message);
    }
}

async function handleMemberJoin(member) {
    try {
        const guild = member.guild;
        const newInvites = await guild.invites.fetch();

        // Find which invite was used
        let usedInvite = null;

        newInvites.forEach(invite => {
            const cachedInvite = inviteCache.get(invite.code);
            if (cachedInvite && invite.uses > cachedInvite.uses) {
                usedInvite = {
                    code: invite.code,
                    inviter: invite.inviter,
                    uses: invite.uses
                };
            }
        });

        if (usedInvite && usedInvite.inviter && !usedInvite.inviter.bot) {
            const inviterId = usedInvite.inviter.id;
            const reward = 500000; // 500k

            // Add money to inviter
            addMoney(inviterId, reward);

            // Send notification to inviter
            try {
                const inviterUser = await discordClient.users.fetch(inviterId);
                const inviteEmbed = new EmbedBuilder()
                    .setColor('#00FF00')
                    .setTitle('🎉 Invite Reward!')
                    .setDescription(`You earned **${formatNumberShort(reward)}** for inviting someone to the server!`)
                    .addFields([
                        { name: '👤 New Member', value: `<@${member.id}>`, inline: true },
                        { name: '💰 Reward', value: formatNumberShort(reward), inline: true },
                        { name: '📊 Your Balance', value: formatNumberShort(getMoney(inviterId)), inline: true },
                        { name: '🔗 Invite Code', value: usedInvite.code, inline: true }
                    ])
                    .setTimestamp();

                await inviterUser.send({ embeds: [inviteEmbed] });
                console.log(`[INVITES] Rewarded ${formatNumberShort(reward)} to ${inviterUser.username} for invite`);
            } catch (dmErr) {
                console.log('[INVITES] Could not DM inviter:', dmErr.message);
            }

            // Log to console
            console.log(`[INVITES] ${member.user.username} joined using invite ${usedInvite.code} by ${usedInvite.inviter.username}`);
        }

        // Update the cache with new invite uses
        await updateInviteCache();

    } catch (err) {
        console.error('[INVITES] Error handling member join:', err.message);
    }
}

// Database functions
function saveUserMoney() {
    try {
        const userMoneyData = {
            users: Object.fromEntries(userMoney),
            metadata: {
                version: '1.0',
                created: new Date().toISOString(),
                lastModified: new Date().toISOString(),
                totalUsers: userMoney.size
            }
        };
        fs.writeFileSync(USER_MONEY_FILE, JSON.stringify(userMoneyData, null, 2));
        console.log(`[DATABASE] Saved ${userMoney.size} user money records to file`);
    } catch (err) {
        console.error('[DATABASE] Error saving user money:', err.message);
    }
}

function loadUserMoney() {
    try {
        if (fs.existsSync(USER_MONEY_FILE)) {
            const data = fs.readFileSync(USER_MONEY_FILE, 'utf8');
            const fileData = JSON.parse(data);
            userMoney = new Map(Object.entries(fileData.users || {}).map(([k, v]) => [k, Number(v)]));
            console.log(`[DATABASE] Loaded ${userMoney.size} user money records from file`);
        } else {
            userMoney = new Map();
            console.log('[DATABASE] No user money file found, creating new structure');
            saveUserMoney();
        }
    } catch (err) {
        console.error('[DATABASE] Error loading user money:', err.message);
        userMoney = new Map();
        saveUserMoney();
    }
}

function saveLinkedUsers() {
    try {
        const linkedUsersData = {
            users: Object.fromEntries(linkedUsers),
            metadata: {
                version: '1.0',
                created: new Date().toISOString(),
                lastModified: new Date().toISOString(),
                totalUsers: linkedUsers.size
            }
        };
        fs.writeFileSync(LINKED_USERS_FILE, JSON.stringify(linkedUsersData, null, 2));
        console.log(`[DATABASE] Saved ${linkedUsers.size} linked users to file`);
    } catch (err) {
        console.error('[DATABASE] Error saving linked users:', err.message);
    }
}

function loadLinkedUsers() {
    try {
        if (fs.existsSync(LINKED_USERS_FILE)) {
            const data = fs.readFileSync(LINKED_USERS_FILE, 'utf8');
            const fileData = JSON.parse(data);
            linkedUsers = new Map(Object.entries(fileData.users || {}));
            console.log(`[DATABASE] Loaded ${linkedUsers.size} linked users from file`);
        } else {
            linkedUsers = new Map();
            console.log('[DATABASE] No linked users file found, creating new structure');
            saveLinkedUsers();
        }
    } catch (err) {
        console.error('[DATABASE] Error loading linked users:', err.message);
        linkedUsers = new Map();
        saveLinkedUsers();
    }
}

function saveGiveaways() {
    try {
        const giveawaysData = {
            activeGiveaways: Object.fromEntries(Array.from(activeGiveaways.entries()).map(([id, giveaway]) => [
                id,
                {
                    ...giveaway,
                    endTime: giveaway.endTime instanceof Date ? giveaway.endTime.toISOString() : giveaway.endTime
                }
            ])),
            metadata: {
                version: '1.0',
                created: new Date().toISOString(),
                lastModified: new Date().toISOString()
            }
        };
        fs.writeFileSync(GIVEAWAYS_FILE, JSON.stringify(giveawaysData, null, 2));
        console.log(`[DATABASE] Saved giveaways to file`);
    } catch (err) {
        console.error('[DATABASE] Error saving giveaways:', err.message);
    }
}

function loadGiveaways() {
    try {
        if (fs.existsSync(GIVEAWAYS_FILE)) {
            const data = fs.readFileSync(GIVEAWAYS_FILE, 'utf8');
            const fileData = JSON.parse(data);

            activeGiveaways = new Map(Object.entries(fileData.activeGiveaways || {}).map(([id, giveaway]) => [
                id,
                {
                    ...giveaway,
                    endTime: new Date(giveaway.endTime)
                }
            ]));

            console.log(`[DATABASE] Loaded ${activeGiveaways.size} active giveaways`);
        } else {
            activeGiveaways = new Map();
            saveGiveaways();
        }
    } catch (err) {
        console.error('[DATABASE] Error loading giveaways:', err.message);
        activeGiveaways = new Map();
        saveGiveaways();
    }
}


function addMoney(userId, amount) {
    const currentMoney = userMoney.get(userId) || 0;
    userMoney.set(userId, currentMoney + amount);
    saveUserMoney();
    console.log(`[MONEY] Added ${formatNumberShort(amount)} to user ${userId}. New balance: ${formatNumberShort(userMoney.get(userId))}`);
}

function getMoney(userId) {
    return userMoney.get(userId) || 0;
}

function resetMoney(userId) {
    userMoney.set(userId, 0);
    saveUserMoney();
    console.log(`[MONEY] Reset money for user ${userId}`);
}

async function sendChatRelay(message, isFromDiscord = false) {
    if (!discordClient || !discordClient.isReady()) return;

    try {
        const chatChannel = discordClient.channels.cache.get(DISCORD_CHAT_RELAY_CHANNEL_ID);
        if (!chatChannel) {
            console.error('[CHAT_RELAY] Chat relay channel not found.');
            return;
        }

        let finalMessage = message;
        if (isFromDiscord) {
            finalMessage = `[From Discord] ${message}`;
        }

        const embed = new EmbedBuilder()
            .setColor(isFromDiscord ? '#7289DA' : '#00FF00')
            .setDescription(finalMessage)
            .setTimestamp();

        if (isFromDiscord) {
            embed.setAuthor({ name: 'Discord → Minecraft' });
        } else {
            embed.setAuthor({ name: 'Minecraft Chat' });
        }

        await chatChannel.send({ embeds: [embed] });
        console.log(`[CHAT_RELAY] ${isFromDiscord ? 'Sent to MC' : 'Relayed from MC'}: ${message}`);
    } catch (err) {
        console.error('[CHAT_RELAY] Error sending chat relay:', err.message);
    }
}

async function fetchPartnerMessages() {
    if (!discordClient || !discordClient.isReady()) return null;

    try {
        const channel = discordClient.channels.cache.get(PARTNER_CHANNEL_ID);
        if (!channel || !channel.isTextBased()) {
            console.error(`[PARTNER_MSG] Channel ${PARTNER_CHANNEL_ID} not found or is not a text channel.`);
            return null;
        }

        // Fetch the last 100 messages from the channel
        const messages = await channel.messages.fetch({ limit: 100 });

        if (messages.size === 0) {
            return "No messages found in the partner channel.";
        }

        // Format messages into a single string
        const formattedMessages = messages.reverse().map(msg =>
            `**${msg.author.username}** [${msg.createdAt.toLocaleTimeString()}]: ${msg.content}`
        ).join('\n');

        return formattedMessages;

    } catch (err) {
        console.error(`[PARTNER_MSG] Error fetching partner messages: ${err.message}`);
        return `An error occurred while fetching messages: ${err.message}`;
    }
}

async function captureScreenshot() {
    if (!bot || !bot.player) {
        console.log('[SCREENSHOT] Bot not ready, skipping screenshot');
        return;
    }

    try {
        // Load mineflayer-viewer plugin for screenshots
        if (!bot.viewer) {
            const mineflayerViewer = require('prismarine-viewer').mineflayer;
            bot.loadPlugin(mineflayerViewer);
        }

        // Capture screenshot
        const screenshot = await bot.viewer.getScreenshot();
        fs.writeFileSync(SCREENSHOT_PATH, screenshot);
        console.log('[SCREENSHOT] Captured and saved screenshot');
    } catch (err) {
        console.log('[SCREENSHOT] Error capturing screenshot:', err.message);
    }
}

function startScreenshotCapture() {
    if (screenshotTimer) {
        clearInterval(screenshotTimer);
        screenshotTimer = null;
    }

    console.log('[SCREENSHOT] Starting screenshot capture...');
    
    screenshotTimer = setInterval(() => {
        if (bot && bot.player && bot.tasksInitialized) {
            captureScreenshot();
        }
    }, SCREENSHOT_INTERVAL);
}

function stopScreenshotCapture() {
    if (screenshotTimer) {
        console.log('[SCREENSHOT] Stopping screenshot capture');
        clearInterval(screenshotTimer);
        screenshotTimer = null;
    }
}

function startAntiAFK() {
    if (afkIntervalId) {
        clearInterval(afkIntervalId);
        afkIntervalId = null;
    }
    console.log('[BOT] Starting minimal anti-AFK system...');

    let actionIndex = 0;
    const antiAfkActions = [
        () => {
            if (bot && bot.player && bot.tasksInitialized) {
                try {
                    bot.look(bot.entity.yaw + (Math.random() * 0.02 - 0.01), bot.entity.pitch + (Math.random() * 0.01 - 0.005));
                } catch (err) {
                    console.log('[ANTI-AFK] Look action failed:', err.message);
                }
            }
        },
        () => {
            if (bot && bot.player && bot.tasksInitialized && Math.random() < 0.1) {
                try {
                    bot.setControlState('sneak', true);
                    setTimeout(() => { if (bot && bot.player) bot.setControlState('sneak', false); }, 50);
                } catch (err) {
                    console.log('[ANTI-AFK] Sneak action failed:', err.message);
                }
            }
        }
    ];

    afkIntervalId = setInterval(() => {
        if (bot && bot.player && bot.tasksInitialized) {
          if (Math.random() < 0.3) {
            const action = antiAfkActions[actionIndex % antiAfkActions.length];
            action();
            actionIndex++;
          }
        } else {
          console.log('[BOT] Anti-AFK: Bot not ready, stopping interval.');
          clearInterval(afkIntervalId);
          afkIntervalId = null;
        }
    }, AFK_INTERVAL);
}

function stopAntiAFK() {
    if (afkIntervalId) {
      console.log('[BOT] Stopping anti-AFK interval.');
      clearInterval(afkIntervalId);
      afkIntervalId = null;
    }
}

function cleanupBot() {
  if (bot) {
    console.log('[CLEANUP] Starting complete bot deletion and cleanup...');
    try {
      stopAntiAFK();
      stopScreenshotCapture();

      bot.tasksInitialized = false;
      bot.removeAllListeners();

      if (bot._client && bot._client.socket && !bot._client.socket.destroyed) {
        console.log('[CLEANUP] Forcefully closing bot connection...');
        bot._client.socket.destroy();
      }

      try {
        bot.quit('Bot cleanup and deletion');
      } catch (quitErr) {
        console.log('[CLEANUP] Bot already disconnected during cleanup');
      }

      console.log('[CLEANUP] Bot completely deleted and cleaned up');
    } catch (err) {
      console.error('[CLEANUP] Error during complete bot deletion:', err.message);
    }

    bot = null;
    if (global.gc) {
      global.gc();
    }
  }
}

function attemptReconnect() {
  if (reconnecting || manualStop) {
    console.log(`[BOT] Skipping reconnect: reconnecting=${reconnecting}, manualStop=${manualStop}`);
    return;
  }

  reconnecting = true;
  connectionAttempts++;

  console.log('[RECONNECT] Ensuring complete bot deletion before reconnection...');
  cleanupBot();

  let baseDelay = Math.min(reconnectDelay * Math.pow(1.1, Math.min(connectionAttempts, 20)), 300000);

  if (connectionAttempts % 100 === 0) {
    console.log('[BOT] Resetting connection attempt counter to prevent permanent long delays...');
    connectionAttempts = 1;
    baseDelay = reconnectDelay;
  }

  const jitter = Math.random() * 2000;
  const delay = baseDelay + jitter;

  console.log(`[BOT] Attempting to reconnect in ${(delay/1000).toFixed(1)} seconds... (attempt ${connectionAttempts})`);

  setTimeout(() => {
    if (!manualStop) {
      reconnecting = false;
      if (bot !== null) {
        console.log('[RECONNECT] Bot reference still exists, forcing null...');
        bot = null;
      }
      createBot();
    } else {
      reconnecting = false;
    }
  }, delay);
}

async function endGiveaway(giveawayId, guildId) {
    const giveaway = activeGiveaways.get(giveawayId);
    if (!giveaway) return;

    try {
        const guild = discordClient.guilds.cache.get(guildId);
        if (!guild) return;

        const channel = guild.channels.cache.get(giveaway.channelId);
        if (!channel) return;

        const message = await channel.messages.fetch(giveawayId);
        if (!message) return;

        const reactions = message.reactions.cache.get('🎉');
        if (!reactions) {
            await message.edit({ content: `${message.content}\n\n**ENDED** - No participants!` });
            activeGiveaways.delete(giveawayId);
            saveGiveaways();
            return;
        }

        const users = await reactions.users.fetch();
        const participants = users.filter(user => !user.bot);

        if (participants.size === 0) {
            await message.edit({ content: `${message.content}\n\n**ENDED** - No participants!` });
            activeGiveaways.delete(giveawayId);
            saveGiveaways();
            return;
        }

        const winner = participants.random();
        const linkedUsername = linkedUsers.get(winner.id);

        const winEmbed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('🎉 Giveaway Ended!')
            .setDescription(`**Winner:** <@${winner.id}>\n**Prize:** ${giveaway.prize}`)
            .setTimestamp();

        if (linkedUsername) {
            // Add money to winner's account
            const prizeAmount = parseMoneyAmount(giveaway.prize);
            if (prizeAmount > 0) {
                addMoney(winner.id, prizeAmount);

                winEmbed.addFields([
                    { name: '🎮 Minecraft Account', value: linkedUsername, inline: true },
                    { name: '💰 Prize Added', value: `${formatNumberShort(prizeAmount)} added to your account!`, inline: true },
                    { name: '📊 Account Balance', value: `${formatNumberShort(getMoney(winner.id))}`, inline: true }
                ]);

                await message.edit({
                    content: `${message.content}\n\n**ENDED**`,
                    embeds: [winEmbed]
                });

                // DM the winner
                try {
                    await winner.send(`🎉 Congratulations! You won **${giveaway.prize}** from a giveaway!\n💰 The money has been added to your account. Use \`/account\` to check your balance.`);
                } catch (dmErr) {
                    console.log('[GIVEAWAY] Could not DM winner:', dmErr.message);
                }
            } else {
                winEmbed.addFields([
                    { name: '🎮 Minecraft Account', value: linkedUsername, inline: true },
                    { name: '🎁 Non-monetary Prize', value: 'Contact staff to claim your prize', inline: true }
                ]);
                await message.edit({ content: `${message.content}\n\n**ENDED**`, embeds: [winEmbed] });
            }
        } else {
            winEmbed.addFields([
                { name: '⚠️ Account Not Linked', value: 'Use `/link <username>` to link your Minecraft account', inline: false }
            ]);
            await message.edit({ content: `${message.content}\n\n**ENDED**`, embeds: [winEmbed] });
        }

        activeGiveaways.delete(giveawayId);
        saveGiveaways();

    } catch (err) {
        console.error('[GIVEAWAY] Error ending giveaway:', err.message);
    }
}

async function rerollGiveaway(giveawayId, guildId) {
    try {
        const guild = discordClient.guilds.cache.get(guildId);
        if (!guild) return;

        const giveaway = activeGiveaways.get(giveawayId);
        if (!giveaway) {
            // Try to find the message anyway for manual rerolls
            const channels = guild.channels.cache.filter(c => c.isTextBased());
            let foundMessage = null;
            let foundChannel = null;

            for (const channel of channels.values()) {
                try {
                    const message = await channel.messages.fetch(giveawayId);
                    if (message) {
                        foundMessage = message;
                        foundChannel = channel;
                        break;
                    }
                } catch (e) {
                    // Continue searching
                }
            }

            if (!foundMessage) return;

            // Get participants from reactions
            const reactions = foundMessage.reactions.cache.get('🎉');
            if (!reactions) return;

            const users = await reactions.users.fetch();
            const participants = users.filter(user => !user.bot);

            if (participants.size === 0) return;

            const newWinner = participants.random();
            const linkedUsername = linkedUsers.get(newWinner.id);

            const rerollEmbed = new EmbedBuilder()
                .setColor('#FFD700')
                .setTitle('🔄 Giveaway Rerolled!')
                .setDescription(`**New Winner:** <@${newWinner.id}>`)
                .setTimestamp();

            if (linkedUsername) {
                rerollEmbed.addFields([
                    { name: '🎮 Minecraft Account', value: linkedUsername, inline: true }
                ]);
            } else {
                rerollEmbed.addFields([
                    { name: '⚠️ Account Not Linked', value: 'Use `/link <username>` to link your Minecraft account', inline: false }
                ]);
            }

            await foundMessage.edit({
                content: foundMessage.content,
                embeds: [rerollEmbed]
            });

            console.log(`[GIVEAWAY] Rerolled giveaway ${giveawayId} - new winner: ${newWinner.id}`);
            return;
        }

        // Normal reroll for active giveaways
        const channel = guild.channels.cache.get(giveaway.channelId);
        if (!channel) return;

        const message = await channel.messages.fetch(giveawayId);
        if (!message) return;

        const reactions = message.reactions.cache.get('🎉');
        if (!reactions) return;

        const users = await reactions.users.fetch();
        const participants = users.filter(user => !user.bot);

        if (participants.size === 0) return;

        const newWinner = participants.random();
        const linkedUsername = linkedUsers.get(newWinner.id);

        const rerollEmbed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('🔄 Giveaway Rerolled!')
            .setDescription(`**New Winner:** <@${newWinner.id}>\n**Prize:** ${giveaway.prize}`)
            .setTimestamp();

        if (linkedUsername) {
            const prizeAmount = parseMoneyAmount(giveaway.prize);
            if (prizeAmount > 0) {
                addMoney(newWinner.id, prizeAmount);

                rerollEmbed.addFields([
                    { name: '🎮 Minecraft Account', value: linkedUsername, inline: true },
                    { name: '💰 Prize Added', value: `${formatNumberShort(prizeAmount)} added to your account!`, inline: true },
                    { name: '📊 Account Balance', value: `${formatNumberShort(getMoney(newWinner.id))}`, inline: true }
                ]);

                // DM the winner
                try {
                    await newWinner.send(`🎉 Congratulations! You won **${giveaway.prize}** from a rerolled giveaway!\n💰 The money has been added to your account. Use \`/account\` to check your balance.`);
                } catch (dmErr) {
                    console.log('[GIVEAWAY] Could not DM reroll winner:', dmErr.message);
                }
            } else {
                rerollEmbed.addFields([
                    { name: '🎮 Minecraft Account', value: linkedUsername, inline: true },
                    { name: '🎁 Non-monetary Prize', value: 'Contact staff to claim your prize', inline: true }
                ]);
            }
        } else {
            rerollEmbed.addFields([
                { name: '⚠️ Account Not Linked', value: 'Use `/link <username>` to link your Minecraft account', inline: false }
            ]);
        }

        await message.edit({
            content: message.content,
            embeds: [rerollEmbed]
        });

        console.log(`[GIVEAWAY] Rerolled giveaway ${giveawayId} - new winner: ${newWinner.id}`);

    } catch (err) {
        console.error('[GIVEAWAY] Error rerolling giveaway:', err.message);
    }
}

async function runEmeraldSequence() {
  if (!bot || !bot.player) {
    console.log('[EMERALD] Bot or player not available, skipping emerald sequence');
    return;
  }

  try {
    console.log('[EMERALD] Starting emerald sequence - selecting middle hotbar slot (4)...');
    await bot.setQuickBarSlot(4);
    console.log('[EMERALD] Hotbar slot 4 selected, current slot:', bot.quickBarSlot);

    const windowOpenHandler = (window) => {
      try {
        console.log(`[EMERALD] Window opened! Type: ${window.type}, Title: ${window.title || 'N/A'}`);
        console.log(`[EMERALD] Window has ${window.slots ? window.slots.length : 0} total slots`);

        setTimeout(() => {
          try {
            if (!window || !window.slots) {
              console.log('[EMERALD] ERROR: Window or slots undefined');
              return;
            }

            console.log('[EMERALD] Processing window slots...');

            let itemCount = 0;
            const itemList = [];
            for (let i = 0; i < window.slots.length; i++) {
              const item = window.slots[i];
              if (item) {
                itemCount++;
                const itemInfo = `Slot ${i}: ${item.name || 'unknown'} (display: ${item.displayName || 'N/A'})`;
                itemList.push(itemInfo);
              }
            }

            console.log(`[EMERALD] Found ${itemCount} items in window`);
            if (itemList.length > 0) {
              console.log('[EMERALD] Items:', itemList.join(' | '));
            }

            let emeraldSlot = -1;
            for (let i = 0; i < window.slots.length; i++) {
              const item = window.slots[i];
              if (item) {
                const name = item.name || '';
                const displayName = item.displayName || '';

                if (name === 'emerald' || 
                    name.includes('emerald') ||
                    displayName === 'Emerald' ||
                    displayName.includes('Emerald')) {
                  emeraldSlot = i;
                  break;
                }
              }
            }

            console.log('[EMERALD] Emerald search result - slot:', emeraldSlot);

            if (emeraldSlot !== -1) {
              console.log(`[EMERALD] Found emerald in slot ${emeraldSlot}, clicking...`);

              expectedDisconnect = true;
              console.log('[EMERALD] Expecting server transfer after emerald click...');

              bot.clickWindow(emeraldSlot, 0, 0, (err) => {
                if (err) {
                  console.log('[EMERALD] Error clicking:', err.message);
                } else {
                  console.log('[EMERALD] Clicked emerald successfully!');
                }
              });

              setTimeout(() => {
                if (bot && bot.player && bot.currentWindow) {
                  console.log('[EMERALD] Closing window...');
                  bot.closeWindow(bot.currentWindow);
                }
              }, 1000);
            } else {
              console.log('[EMERALD] WARNING: No emerald found in the window!');
            }
          } catch (innerErr) {
            console.log('[EMERALD] ERROR in window processing:', innerErr.message);
            console.log('[EMERALD] Stack:', innerErr.stack);
          }
        }, 200);

        bot.removeListener('windowOpen', windowOpenHandler);

      } catch (err) {
        console.log('[EMERALD] ERROR in windowOpenHandler:', err.message);
        console.log('[EMERALD] Stack:', err.stack);
      }
    };

    bot.on('windowOpen', windowOpenHandler);
    console.log('[EMERALD] Window open listener registered');

    setTimeout(() => {
      console.log('[EMERALD] Activating item in hand to open chest/GUI...');
      bot.activateItem();
      console.log('[EMERALD] activateItem() called');
    }, 500);

  } catch (err) {
    console.log('[EMERALD] ERROR during hotbar/chest sequence:', err.message);
    console.log('[EMERALD] Stack trace:', err.stack);
  }
}

function createBot() {
  if (bot && bot.player && bot.tasksInitialized) {
    console.log('[BOT] Bot instance is already online and initialized, not creating a new one.');
    return;
  }
  if (manualStop) {
    console.log('[BOT] Manual stop is active, not creating bot.');
    return;
  }
  if (reconnecting) {
    console.log('[BOT] Already in reconnection process, skipping.');
    return;
  }

  if (bot) {
    console.log('[BOT] Completely deleting old bot instance...');
    cleanupBot();
    bot = null;
    if (global.gc) {
      global.gc();
    }
  }

  // Clear any existing emerald sequence timer
  if (emeraldSequenceTimer) {
    clearTimeout(emeraldSequenceTimer);
    emeraldSequenceTimer = null;
  }

  connectionAttempts++;
  console.log(`[BOT] Creating Minecraft bot (attempt ${connectionAttempts}) for ${process.env.MC_EMAIL}...`);

  reconnecting = true;

  const authOptions = {
    host: 'neosmp.me',
    port: 30019,
    username: process.env.MC_EMAIL,
    auth: 'microsoft',
    version: '1.20.4',
    checkTimeoutInterval: 300 * 1000,
    defaultChatPatterns: true,
    keepAlive: true,
    respawn: true,
    hideErrors: false,
    timeout: 300 * 1000,
    reconnect: false,
    sessionServer: 'https://sessionserver.mojang.com',
    profilesFolder: './profiles',
    skipValidation: false,
    brand: 'vanilla',
    physicsEnabled: false,
    clientToken: process.env.MC_EMAIL.replace(/[@.]/g, '_') + '_' + Date.now(),
    authFlow: {
      forceRefresh: false
    },
    onMsaCode: async (data) => {
      console.log('\n=== MICROSOFT AUTHENTICATION REQUIRED ===');
      console.log(`Please go to: ${data.verification_uri}`);
      console.log(`Enter this code: ${data.user_code}`);
      console.log('=== Waiting for authentication... ===\n');

      if (discordClient && discordClient.isReady()) {
        try {
          const authEmbed = new EmbedBuilder()
            .setColor('#FF6B35')
            .setTitle('🔐 Microsoft Authentication Required')
            .setDescription(`**Go to:** ${data.verification_uri}\n**Enter code:** \`${data.user_code}\``)
            .addFields([
              { name: 'Instructions', value: '1. Click the link above\n2. Enter the code\n3. Sign in with your Microsoft account\n4. Wait for bot to connect' }
            ])
            .setTimestamp();

          const owner = await discordClient.users.fetch(DISCORD_OWNER_ID);
          if (owner) {
            await owner.send({ embeds: [authEmbed] });
            console.log('[AUTH] Sent authentication details to Discord DM');
          }
        } catch (err) {
          console.error('[AUTH] Failed to send auth details to Discord:', err.message);
        }
      }
    }
  };

  try {
    bot = mineflayer.createBot(authOptions);

    // Load pathfinder plugin for navigation
    const pathfinder = require('mineflayer-pathfinder').pathfinder;
    const Movements = require('mineflayer-pathfinder').Movements;
    const { GoalBlock } = require('mineflayer-pathfinder').goals;

    bot.loadPlugin(pathfinder);
  } catch (createError) {
    console.error('[BOT] Error creating bot:', createError.message);
    reconnecting = false;
    setTimeout(() => attemptReconnect(), 10000);
    return;
  }

  bot.on('login', () => {
    console.log(`[BOT] Successfully logged in as ${bot.username}`);
  });

  bot.on('spawn', () => {
    console.log(`[BOT] Bot spawned! IGN: ${bot.username} (Connection attempt ${connectionAttempts})`);
    connectionAttempts = 0;
    reconnecting = false;
    lastSuccessfulConnection = Date.now();
    bot.tasksInitialized = false;

    // Clear any pending emerald sequence timer since we've successfully reconnected
    if (emeraldSequenceTimer) {
      clearTimeout(emeraldSequenceTimer);
      emeraldSequenceTimer = null;
    }

    // Initial emerald sequence (2 seconds after spawn)
    setTimeout(() => runEmeraldSequence(), 2000);

    setTimeout(() => {
        if (!bot || !bot.player) {
          console.log('[BOT] Bot instance lost before navigating to coordinates.');
          return;
        }

        // Set tasks as initialized since bot is functional
        if (!bot.tasksInitialized) {
          bot.tasksInitialized = true;
          startAntiAFK();
          startScreenshotCapture();
          console.log('[BOT] Tasks initialized after successful spawn.');
        }

        console.log('[BOT] Bot fully spawned, navigating to coordinates -29, -29, 41...');

        // Navigate to the specified coordinates
        const targetX = -29;
        const targetZ = -29;
        const targetY = 41;

        // Set up pathfinder with movements
        const { GoalBlock } = require('mineflayer-pathfinder').goals;
        const Movements = require('mineflayer-pathfinder').Movements;

        const movements = new Movements(bot);
        bot.pathfinder.setMovements(movements);

        const goal = new GoalBlock(targetX, targetY, targetZ);
        bot.pathfinder.setGoal(goal);

        console.log(`[BOT] Moving to coordinates: ${targetX}, ${targetY}, ${targetZ}`);

        // Wait for the bot to reach the destination, then look for players
        setTimeout(() => {
          if (!bot || !bot.player) return;

          console.log('[BOT] Reached destination, looking for players to click...');

          // Find the nearest player (excluding the bot itself)
          const players = Object.values(bot.players).filter(player => 
            player.entity && 
            player.username !== bot.username &&
            player.entity.id !== bot.entity.id &&
            bot.entity.position.distanceTo(player.entity.position) < 10
          );

          if (players.length > 0) {
            const nearestPlayer = players[0];
            console.log(`[BOT] Found player: ${nearestPlayer.username}, attempting to click...`);

            // Look at the player and right-click
            bot.lookAt(nearestPlayer.entity.position.offset(0, nearestPlayer.entity.height, 0));

            setTimeout(() => {
              bot.activateEntity(nearestPlayer.entity);
              console.log(`[BOT] Clicked on player: ${nearestPlayer.username}`);
              expectedDisconnect = true;
            }, 1000);
          } else {
            console.log('[BOT] No other players found nearby, trying to find NPCs...');

            // Look for any nearby entities that might be NPCs (excluding the bot itself)
            const nearbyEntities = Object.values(bot.entities).filter(entity => 
              entity.id !== bot.entity.id && // Exclude bot itself
              entity.username !== bot.username && // Double check username
              (entity.type === 'player' ||
               entity.type === 'villager' ||
               entity.type === 'armor_stand' ||
               entity.name?.toLowerCase().includes('npc') ||
               entity.displayName?.toLowerCase().includes('npc'))
            ).filter(entity => 
              entity.position && 
              bot.entity.position.distanceTo(entity.position) < 10
            );

            if (nearbyEntities.length > 0) {
              const targetEntity = nearbyEntities[0];
              console.log(`[BOT] Found entity: ${targetEntity.name || targetEntity.displayName || targetEntity.type} (ID: ${targetEntity.id}), attempting to click...`);

              bot.lookAt(targetEntity.position.offset(0, 1.6, 0));

              setTimeout(() => {
                bot.activateEntity(targetEntity);
                console.log(`[BOT] Clicked on entity: ${targetEntity.name || targetEntity.displayName || targetEntity.type}`);
                expectedDisconnect = true;
              }, 1000);
            } else {
              console.log('[BOT] No clickable entities found at coordinates. Available entities:');
              Object.values(bot.entities).forEach(entity => {
                if (entity.position && bot.entity.position.distanceTo(entity.position) < 15) {
                  console.log(`  - ${entity.name || entity.displayName || entity.type} (ID: ${entity.id}, Distance: ${bot.entity.position.distanceTo(entity.position).toFixed(2)})`);
                }
              });
            }
          }
        }, 5000);
    }, 15000);
  });

  bot.on('message', (jsonMsg) => {
    if (!bot) return;
    const msg = jsonMsg.toString();

    // Check for incoming payments - support multiple formats
    const paymentPattern1 = /(\w+) has sent you \$?([\d,kmbt.]+)/i;
    const paymentPattern2 = /You received \$?([\d,kmbt.]+) from ([\w.]+)/i;
    
    let paymentMatch = msg.match(paymentPattern1);
    let senderUsername = null;
    let amountStr = null;
    
    if (paymentMatch) {
        senderUsername = paymentMatch[1];
        amountStr = paymentMatch[2];
    } else {
        paymentMatch = msg.match(paymentPattern2);
        if (paymentMatch) {
            amountStr = paymentMatch[1];
            senderUsername = paymentMatch[2];
        }
    }

    if (paymentMatch && senderUsername && amountStr) {
        const amount = parseMoneyAmount(amountStr);
        const taxRate = 0.10;
        const taxAmount = amount * taxRate;
        const amountAfterTax = amount - taxAmount;

        console.log(`[PAYMENT] Detected payment from ${senderUsername}: ${formatNumberShort(amount)} (Tax: ${formatNumberShort(taxAmount)}, After Tax: ${formatNumberShort(amountAfterTax)})`);

        // Find the Discord user by linked username (case-insensitive, handle any variation)
        const discordUserId = Array.from(linkedUsers.entries()).find(([, mcUsername]) => {
            const cleanSender = senderUsername.toLowerCase().replace(/[^a-z0-9]/g, '');
            const cleanLinked = mcUsername.toLowerCase().replace(/[^a-z0-9]/g, '');
            return cleanLinked === cleanSender || mcUsername.toLowerCase() === senderUsername.toLowerCase();
        })?.[0];

        if (discordUserId && amount > 0) {
            addMoney(discordUserId, amountAfterTax);
            console.log(`[PAYMENT] Added ${formatNumberShort(amountAfterTax)} to ${discordUserId}'s account from payment (matched ${senderUsername} to ${linkedUsers.get(discordUserId)})`);

            // Notify the user
            try {
                discordClient.users.fetch(discordUserId).then(user => {
                    const paymentEmbed = new EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle('💰 Payment Received!')
                        .setDescription(`You sent **${formatNumberShort(amount)}** to the bot. After 10% tax, **${formatNumberShort(amountAfterTax)}** has been added to your account!`)
                        .addFields([
                            { name: '💵 Amount Sent', value: formatNumberShort(amount), inline: true },
                            { name: '🏦 Tax (10%)', value: formatNumberShort(taxAmount), inline: true },
                            { name: '✅ Amount Received', value: formatNumberShort(amountAfterTax), inline: true },
                            { name: '📊 New Balance', value: formatNumberShort(getMoney(discordUserId)), inline: true },
                            { name: '🎮 Minecraft Username', value: senderUsername, inline: true }
                        ])
                        .setTimestamp();

                    user.send({ embeds: [paymentEmbed] }).catch(err => 
                        console.log(`[PAYMENT] Could not DM user ${discordUserId}:`, err.message)
                    );
                }).catch(err => console.log(`[PAYMENT] Could not fetch user ${discordUserId}:`, err.message));
            } catch (err) {
                console.log(`[PAYMENT] Error notifying user:`, err.message);
            }
        }
    }

    // Relay chat messages
    if (bot.tasksInitialized && msg.trim() !== '' && msg.length > 0 && !msg.includes('TryAFK')) {
        const cleanedMsg = msg.replace(/§[0-9a-fk-or]/g, '').replace(/▏\s*/g, '').replace(/^\s*TrySmp\s*»\s*/i, '').trim();
        if (cleanedMsg && !/^[»\s▏.]*$/.test(cleanedMsg) && !/^(Your balance is|You are already on|Sending you to|You have been added to the queue|Usage:|Invalid amount)/.test(msg)) {
            sendChatRelay(cleanedMsg, false);
        }
    }

    // Server connection detection
    const serverMessages = [
        "You are already on the server economy-euc",
        "Sending you to economy-euc",
        "You have been added to the queue for economy-euc",
        "Connected to economy-euc",
        "Welcome to economy-euc"
    ];

    const isServerMessage = serverMessages.some(pattern => msg.toLowerCase().includes(pattern.toLowerCase()));

    if (isServerMessage && !bot.tasksInitialized) {
        console.log('[BOT] Confirmed connection to economy-euc server. Initializing tasks...');
        expectedDisconnect = false;

        setTimeout(() => {
            if (bot && bot.player && !bot.tasksInitialized) {
                startAntiAFK();
                bot.tasksInitialized = true;
                console.log('[BOT] Tasks initialized successfully after server confirmation.');
            }
        }, 3000);
        return;
    }

    if (pendingSayInteraction && msg.includes('TrySmp »')) {
        console.log(`[BOT_CHAT] Detected "TrySmp" message for /say command: ${msg}`);
        const interactionToReply = pendingSayInteraction;
        pendingSayInteraction = null;

        const responseEmbed = new EmbedBuilder()
            .setColor('#2ECC71')
            .setTitle('Minecraft Response')
            .setDescription(`The bot said its message and received the following response:\n\n\`\`\`${msg}\`\`\``)
            .setTimestamp();

        if (USE_DMS_FOR_OWNER) {
            interactionToReply.user.send({ embeds: [responseEmbed] }).catch(err => console.error(`[DISCORD] Failed to send /say response to DM: ${err.message}`));
            interactionToReply.editReply({ content: 'Response received from Minecraft. Check your DMs.', flags: 64 });
        } else {
            interactionToReply.editReply({ embeds: [responseEmbed], flags: 0 });
        }
    }
  });

  bot.on('kicked', (reason) => {
    let reasonStr = '';
    try {
      if (typeof reason === 'string') {
        reasonStr = reason;
      } else if (typeof reason === 'object' && reason !== null) {
        reasonStr = JSON.stringify(reason);
      } else {
        reasonStr = String(reason || 'Unknown reason');
      }
    } catch (err) {
      reasonStr = 'Failed to parse kick reason';
    }

    console.warn(`[BOT] Kicked from Minecraft server. Reason: ${reasonStr}`);
    cleanupBot();

    if (expectedDisconnect) {
        console.log('[BOT] Expected disconnect due to server transfer. Will reconnect after delay.');
        expectedDisconnect = false;
        setTimeout(() => attemptReconnect(), 8000);
        return;
    }
    if (!manualStop) {
        setTimeout(() => attemptReconnect(), 15000);
    }
  });

  bot.on('error', (err) => {
    console.error(`[BOT_ERROR] Minecraft bot error: ${err.message}`);

    cleanupBot();

    if (expectedDisconnect) {
        console.log('[BOT] Error during expected server transfer. Will reconnect after short delay.');
        expectedDisconnect = false;
        setTimeout(() => attemptReconnect(), 8000);
        return;
    }

    if (!manualStop) {
        console.log('[BOT] Scheduling emerald reconnection 3 minutes after error...');
        if (emeraldSequenceTimer) {
          clearTimeout(emeraldSequenceTimer);
          emeraldSequenceTimer = null;
        }
        emeraldSequenceTimer = setTimeout(() => {
          console.log('[AUTO-EMERALD] 3 minutes elapsed since error, reconnecting and running emerald sequence...');
          emeraldSequenceTimer = null;
          attemptReconnect();
        }, 180000); // 3 minutes
    }
  });

  bot.on('end', () => {
    console.warn('[BOT] Minecraft bot disconnected.');
    cleanupBot();
    if (expectedDisconnect) {
        console.log('[BOT] Expected disconnect due to server transfer. Will reconnect after short delay.');
        expectedDisconnect = false;
        setTimeout(() => attemptReconnect(), 5000);
        return;
    }
    if (!manualStop) {
        console.log('[BOT] Scheduling emerald reconnection 3 minutes after disconnect...');
        if (emeraldSequenceTimer) {
          clearTimeout(emeraldSequenceTimer);
          emeraldSequenceTimer = null;
        }
        emeraldSequenceTimer = setTimeout(() => {
          console.log('[AUTO-EMERALD] 3 minutes elapsed since disconnect, reconnecting and running emerald sequence...');
          emeraldSequenceTimer = null;
          attemptReconnect();
        }, 180000); // 3 minutes
    }
  });
}

discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildInvites,
    ],
    partials: [],
});

const commands = [
    new SlashCommandBuilder()
        .setName('chat')
        .setDescription('Send a message to Minecraft chat (Authorized Only).')
        .addStringOption(option =>
            option.setName('message')
                .setDescription('Message to send to Minecraft')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('link')
        .setDescription('Link your Discord account to a Minecraft username.')
        .addStringOption(option =>
            option.setName('username')
                .setDescription('Your Minecraft username')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('account')
        .setDescription('Check your giveaway winnings account balance.'),
    new SlashCommandBuilder()
        .setName('reset')
        .setDescription('Reset a user\'s money balance (Authorized Only).')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User to reset money for')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('add')
        .setDescription('Add money to a user\'s balance (Authorized Only).')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User to add money to')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('amount')
                .setDescription('Amount to add (supports k, m, b, t suffixes)')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('bal')
        .setDescription('Check a user\'s balance (Authorized Only).')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User to check balance for')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Show top 10 users by balance.'),
    new SlashCommandBuilder()
        .setName('accept')
        .setDescription('Accept a teleport request in Minecraft (Authorized Only).'),
    new SlashCommandBuilder()
        .setName('info')
        .setDescription('Show information about rewards and payouts.'),
    new SlashCommandBuilder()
        .setName('partner')
        .setDescription('View partnership information and messages from the partner channel.')
        .setDMPermission(true),
    new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Check a player\'s balance in Minecraft (Authorized Only).')
        .addStringOption(option =>
            option.setName('username')
                .setDescription('Minecraft username to check balance for')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('payout')
        .setDescription('Manually trigger payouts (Authorized Only).')
        .addStringOption(option =>
            option.setName('target')
                .setDescription('Payout target: specific user or all users')
                .setRequired(true)
                .addChoices(
                    { name: 'All Users', value: 'all' },
                    { name: 'Specific User', value: 'user' }
                )
        )
        .addUserOption(option =>
            option.setName('user')
                .setDescription('Specific user to payout (only if target is "user")')
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('mod')
        .setDescription('Moderator commands for giveaways (Authorized Only).')
        .addSubcommand(subcommand =>
            subcommand
                .setName('giveaway')
                .setDescription('Start a new giveaway.')
                .addStringOption(option =>
                    option.setName('prize')
                        .setDescription('The prize for the giveaway (use format like "10m" for money)')
                        .setRequired(true)
                )
                .addIntegerOption(option =>
                    option.setName('duration')
                        .setDescription('Duration in minutes (default: 60)')
                        .setRequired(false)
                        .setMinValue(1)
                        .setMaxValue(10080)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('end')
                .setDescription('End a giveaway early.')
                .addStringOption(option =>
                    option.setName('message_id')
                        .setDescription('Message ID of the giveaway to end')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('reroll')
                .setDescription('Reroll a giveaway winner.')
                .addStringOption(option =>
                    option.setName('message_id')
                        .setDescription('Message ID of the giveaway to reroll')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('stop')
                .setDescription('Stop/cancel a giveaway.')
                .addStringOption(option =>
                    option.setName('message_id')
                        .setDescription('Message ID of the giveaway to stop')
                        .setRequired(true)
                )
        ),
    new SlashCommandBuilder()
        .setName('coinflip')
        .setDescription('Flip a coin and bet money!')
        .addStringOption(option =>
            option.setName('bet')
                .setDescription('Amount to bet (supports k, m, b, t suffixes)')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('choice')
                .setDescription('Heads or Tails?')
                .setRequired(true)
                .addChoices(
                    { name: 'Heads', value: 'heads' },
                    { name: 'Tails', value: 'tails' }
                )
        ),
    new SlashCommandBuilder()
        .setName('slots')
        .setDescription('Play the slot machine and win big!')
        .addStringOption(option =>
            option.setName('bet')
                .setDescription('Amount to bet (supports k, m, b, t suffixes)')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('perms')
        .setDescription('Manage user permissions and command toggles (Owner Only).')
        .addSubcommand(subcommand =>
            subcommand
                .setName('user')
                .setDescription('Add or remove authorized users.')
                .addStringOption(option =>
                    option.setName('action')
                        .setDescription('Action to perform')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Add', value: 'add' },
                            { name: 'Remove', value: 'remove' },
                            { name: 'List', value: 'list' }
                        )
                )
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('User to authorize/deauthorize')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('toggle')
                .setDescription('Toggle specific commands on/off.')
                .addStringOption(option =>
                    option.setName('command')
                        .setDescription('Command to toggle')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Giveaways (/mod giveaway)', value: 'giveaways' },
                            { name: 'Add Money (/add)', value: 'add' },
                            { name: 'Reset Balance (/reset)', value: 'reset' },
                            { name: 'Payout (/payout)', value: 'payout' },
                            { name: 'Coinflip (/coinflip)', value: 'coinflip' },
                            { name: 'Slots (/slots)', value: 'slots' }
                        )
                )
                .addStringOption(option =>
                    option.setName('status')
                        .setDescription('Enable or disable the command')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Enable', value: 'enable' },
                            { name: 'Disable', value: 'disable' }
                        )
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('view')
                .setDescription('View current permission settings.')
        )
];

discordClient.once(Events.ClientReady, async c => {
    console.log(`[DISCORD] Discord Ready! Logged in as ${c.user.tag}`);

    const guild = c.guilds.cache.get(DISCORD_GUILD_ID);
    if (!guild) {
        console.error(`[DISCORD] Bot is not in guild ${DISCORD_GUILD_ID}. Please invite the bot to your server.`);
        return;
    }

    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    try {
        console.log('[DISCORD] Started refreshing application (/) commands.');
        
        // Clear global commands (one-time cleanup)
        await rest.put(
            Routes.applicationCommands(c.user.id),
            { body: [] },
        );
        console.log('[DISCORD] Cleared global commands.');
        
        // Only register guild commands to avoid duplicates
        // Guild commands update instantly, global commands can take up to an hour
        await rest.put(
            Routes.applicationGuildCommands(c.user.id, DISCORD_GUILD_ID),
            { body: commands.map(command => command.toJSON()) },
        );
        console.log('[DISCORD] Successfully reloaded guild commands.');
    } catch (error) {
        console.error(`[DISCORD] Failed to reload application (/) commands: ${error.message}`);
    }

    // Initialize invite cache
    await updateInviteCache();

    createBot();
});

// Handle member joins for invite tracking
discordClient.on(Events.GuildMemberAdd, handleMemberJoin);

// Handle messages in chat relay channels
discordClient.on('messageCreate', async (message) => {
    if (message.author.bot && message.author.id === discordClient.user.id) {
        if (message.channel.id === DISCORD_CHAT_RELAY_CHANNEL_ID ||
            message.channel.id === DISCORD_CHAT_RELAY_CHANNEL_ID_2) {
            try {
                await message.react('🤖');
            } catch (err) {
                console.error('[CHAT_RELAY] Failed to react to own message:', err.message);
            }
        }
        return;
    }

    if (message.author.bot) {
        return;
    }

    // Check if message is in relay channels
    if (message.channel.id !== DISCORD_CHAT_RELAY_CHANNEL_ID &&
        message.channel.id !== DISCORD_CHAT_RELAY_CHANNEL_ID_2) {
        return;
    }

    const content = message.content || '';

    // Always react to show message was received
    try {
        await message.react('👀');
    } catch (err) {
        console.error('[CHAT_RELAY] Failed to react to message:', err.message);
    }

    // Check if bot is ready and connected to Minecraft
    if (!bot || !bot.player) {
        try {
            await message.react('❌');
        } catch (err) {
            console.error('[CHAT_RELAY] Failed to react with error:', err.message);
        }
        return;
    }

    try {
        let mcMessage;
        if (content.trim()) {
            mcMessage = `[Discord] ${message.author.username}: ${content.trim()}`;
        } else {
            mcMessage = `[Discord] ${message.author.username} sent an empty message`;
        }

        bot.chat(mcMessage);
        await sendChatRelay(mcMessage, true);

        await message.react('✅');
    } catch (err) {
        console.error('[CHAT_RELAY] Error sending message to Minecraft:', err.message);
        try {
            await message.react('❌');
        } catch (reactErr) {
            console.error('[CHAT_RELAY] Failed to react with error:', reactErr.message);
        }
    }
});

discordClient.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isCommand()) return;

    try {
        const { commandName } = interaction;

        if (commandName === 'chat') {
            console.log(`[DISCORD_CMD] /chat command received from ${interaction.user.tag}.`);
            if (!isAuthorizedUser(interaction.user.id)) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }

            if (!bot || !bot.player || !bot.tasksInitialized) {
                return interaction.reply({ content: 'Minecraft bot is not online or not fully initialized. Please try again in a moment.', ephemeral: true });
            }

            const message = interaction.options.getString('message');

            await interaction.deferReply({ ephemeral: true });

            bot.chat(message);
            console.log(`[CHAT_RELAY] Sent to Minecraft: ${message}`);

            await sendChatRelay(`**${interaction.user.username}:** ${message}`, true);

            await interaction.editReply({
                content: `✅ **Message sent to Minecraft:**\n\`${message}\``
            });

        } else if (commandName === 'accept') {
            console.log(`[DISCORD_CMD] /accept command received from ${interaction.user.tag}.`);
            if (!isAuthorizedUser(interaction.user.id)) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }

            if (!bot || !bot.player) {
                return interaction.reply({ content: 'Minecraft bot is not online. Please wait for the bot to connect.', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            try {
                // Set up window open listener for lime green glass
                const windowOpenHandler = (window) => {
                    try {
                        console.log(`[ACCEPT] Window opened! Type: ${window.type}, Title: ${window.title || 'N/A'}`);
                        console.log(`[ACCEPT] Window has ${window.slots ? window.slots.length : 0} total slots`);

                        setTimeout(() => {
                            try {
                                if (!window || !window.slots) {
                                    console.log('[ACCEPT] ERROR: Window or slots undefined');
                                    return;
                                }

                                console.log('[ACCEPT] Processing window slots for lime green glass...');

                                // Look for lime green glass in the window
                                let limeGlassSlot = -1;
                                for (let i = 0; i < window.slots.length; i++) {
                                    const item = window.slots[i];
                                    if (item) {
                                        const name = item.name || '';
                                        const displayName = item.displayName || '';

                                        if (name === 'lime_dye' || 
                                            name.includes('lime') ||
                                            displayName.includes('Lime') ||
                                            name === 'lime_stained_glass_pane' ||
                                            displayName.includes('Lime Stained Glass')) {
                                            limeGlassSlot = i;
                                            break;
                                        }
                                    }
                                }

                                console.log('[ACCEPT] Lime green glass search result - slot:', limeGlassSlot);

                                if (limeGlassSlot !== -1) {
                                    console.log(`[ACCEPT] Found lime green glass in slot ${limeGlassSlot}, clicking...`);

                                    // Click the lime green glass (left click)
                                    bot.clickWindow(limeGlassSlot, 0, 0, (err) => {
                                        if (err) {
                                            console.log('[ACCEPT] Error clicking:', err.message);
                                        } else {
                                            console.log('[ACCEPT] Clicked lime green glass successfully!');
                                        }
                                    });

                                    // Close window after a moment
                                    setTimeout(() => {
                                        if (bot && bot.player && bot.currentWindow) {
                                            console.log('[ACCEPT] Closing window...');
                                            bot.closeWindow(bot.currentWindow);
                                        }
                                    }, 1000);
                                } else {
                                    console.log('[ACCEPT] WARNING: No lime green glass found in the window!');
                                }
                            } catch (innerErr) {
                                console.log('[ACCEPT] ERROR in window processing:', innerErr.message);
                            }
                        }, 200);

                        // Remove the listener after handling
                        bot.removeListener('windowOpen', windowOpenHandler);

                    } catch (err) {
                        console.log('[ACCEPT] ERROR in windowOpenHandler:', err.message);
                    }
                };

                // Register the window open listener
                bot.on('windowOpen', windowOpenHandler);
                console.log('[ACCEPT] Window open listener registered for lime green glass');

                // Send /tpaaccept command to Minecraft
                bot.chat('/tpaaccept');
                console.log('[ACCEPT] Sent /tpaaccept command to Minecraft');

                await interaction.editReply({
                    content: '✅ **Teleport request accepted!**\nSent `/tpaaccept` command and will click lime green glass if a window opens.'
                });

                // Remove the listener after 10 seconds if no window opens
                setTimeout(() => {
                    bot.removeListener('windowOpen', windowOpenHandler);
                    console.log('[ACCEPT] Removed window listener after timeout');
                }, 10000);

            } catch (error) {
                console.error('[ACCEPT] Error during accept command:', error.message);
                await interaction.editReply({
                    content: '❌ **Error accepting teleport request.**\nPlease try again.'
                });
            }

        } else if (commandName === 'link') {
            const username = interaction.options.getString('username');
            const userId = interaction.user.id;

            // Check if user is already linked
            if (linkedUsers.has(userId)) {
                return interaction.reply({
                    content: `❌ You are already linked to **${linkedUsers.get(userId)}**. Contact staff to change your linked account.`,
                    ephemeral: true
                });
            }

            // Check if username is already linked to someone else
            const existingUser = Array.from(linkedUsers.entries()).find(([, mcUsername]) => mcUsername.toLowerCase() === username.toLowerCase());
            if (existingUser) {
                return interaction.reply({
                    content: `❌ The username **${username}** is already linked to another Discord account.`,
                    ephemeral: true
                });
            }

            // Link the account
            linkedUsers.set(userId, username);
            saveLinkedUsers();

            const successEmbed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('✅ Account Successfully Linked!')
                .setDescription(`Your Discord account has been linked to **${username}**`)
                .addFields([
                    { name: '🎉 Benefits', value: '• Auto-receive giveaway prizes in your account\n• Check balance with `/account`\n• Seamless prize management', inline: false },
                    { name: '🎮 Linked Account', value: username, inline: true },
                    { name: '👤 Discord User', value: `<@${userId}>`, inline: true }
                ])
                .setTimestamp();

            await interaction.reply({ embeds: [successEmbed], ephemeral: false });

        } else if (commandName === 'account') {
            const userId = interaction.user.id;
            const linkedUsername = linkedUsers.get(userId);
            const balance = getMoney(userId);

            if (!linkedUsername) {
                return interaction.reply({
                    content: '❌ You need to link your Minecraft account first using `/link <username>`.',
                    ephemeral: true
                });
            }

            const accountEmbed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('💰 Your Account Balance')
                .setDescription(`Here's your giveaway winnings account information:`)
                .addFields([
                    { name: '🎮 Linked Minecraft Account', value: linkedUsername, inline: true },
                    { name: '💰 Current Balance', value: formatNumberShort(balance), inline: true },
                    { name: '📊 Total Winnings', value: `You have won ${formatNumberShort(balance)} from giveaways!`, inline: false },
                    { name: 'ℹ️ How it works', value: 'When you win giveaways, the prize money is automatically added to this account balance. Contact staff to withdraw your winnings to Minecraft.', inline: false }
                ])
                .setFooter({ text: 'Giveaway Winnings System' })
                .setTimestamp();

            await interaction.reply({ embeds: [accountEmbed], ephemeral: true });

        } else if (commandName === 'bal') {
            if (!isAuthorizedUser(interaction.user.id)) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }

            const targetUser = interaction.options.getUser('user');
            const balance = getMoney(targetUser.id);
            const linkedUsername = linkedUsers.get(targetUser.id);

            const balEmbed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle(`💰 Balance for ${targetUser.username}`)
                .addFields([
                    { name: '👤 Discord User', value: `<@${targetUser.id}>`, inline: true },
                    { name: '💰 Current Balance', value: formatNumberShort(balance), inline: true },
                    { name: '🎮 Linked Account', value: linkedUsername || 'Not linked', inline: true }
                ])
                .setTimestamp();

            await interaction.reply({ embeds: [balEmbed], ephemeral: true });

        } else if (commandName === 'leaderboard') {
            // Get top 10 users by balance from Map
            const sortedUsers = Array.from(userMoney.entries())
                .sort(([,a], [,b]) => b - a)
                .slice(0, 10);

            if (sortedUsers.length === 0) {
                return interaction.reply({ content: '📊 No users found with money yet!', ephemeral: true });
            }

            const leaderboardEmbed = new EmbedBuilder()
                .setColor('#FFD700')
                .setTitle('🏆 Money Leaderboard - Top 10')
                .setDescription('Here are the richest users from giveaway winnings:')
                .setTimestamp();

            let description = '';
            for (let i = 0; i < sortedUsers.length; i++) {
                const [userId, balance] = sortedUsers[i];
                const user = await interaction.client.users.fetch(userId).catch(() => null);
                const username = user ? user.username : 'Unknown User';
                const linkedAccount = linkedUsers.get(userId) || 'Not linked';

                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                description += `${medal} **${username}** - ${formatNumberShort(balance)}\n🎮 ${linkedAccount}\n\n`;
            }

            leaderboardEmbed.setDescription(description);
            await interaction.reply({ embeds: [leaderboardEmbed], ephemeral: false });

        } else if (commandName === 'reset') {
            if (!isAuthorizedUser(interaction.user.id)) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }

            if (!isCommandEnabled('reset')) {
                return interaction.reply({ content: '❌ The reset command is currently disabled.', ephemeral: true });
            }

            const targetUser = interaction.options.getUser('user');
            const oldBalance = getMoney(targetUser.id);

            resetMoney(targetUser.id);

            await interaction.reply({
                content: `✅ **Reset money balance for <@${targetUser.id}>**\n• **Previous Balance:** ${formatNumberShort(oldBalance)}\n• **New Balance:** ${formatNumberShort(0)}`,
                ephemeral: true
            });

        } else if (commandName === 'add') {
            if (!isAuthorizedUser(interaction.user.id)) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }

            if (!isCommandEnabled('add')) {
                return interaction.reply({ content: '❌ The add command is currently disabled.', ephemeral: true });
            }

            const targetUser = interaction.options.getUser('user');
            const amountStr = interaction.options.getString('amount');
            const amount = parseMoneyAmount(amountStr);

            if (amount <= 0) {
                return interaction.reply({ content: '❌ Please enter a valid positive amount.', ephemeral: true });
            }

            const oldBalance = getMoney(targetUser.id);
            addMoney(targetUser.id, amount);
            const newBalance = getMoney(targetUser.id);

            const addEmbed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('💰 Money Added Successfully')
                .setDescription(`Added money to <@${targetUser.id}>'s account`)
                .addFields([
                    { name: '👤 Target User', value: `<@${targetUser.id}>`, inline: true },
                    { name: '💵 Amount Added', value: formatNumberShort(amount), inline: true },
                    { name: '📊 Previous Balance', value: formatNumberShort(oldBalance), inline: true },
                    { name: '💰 New Balance', value: formatNumberShort(newBalance), inline: true },
                    { name: '🎮 Linked Account', value: linkedUsers.get(targetUser.id) || 'Not linked', inline: true },
                    { name: '👨‍💼 Added by', value: `<@${interaction.user.id}>`, inline: true }
                ])
                .setTimestamp();

            await interaction.reply({ embeds: [addEmbed], ephemeral: true });

        } else if (commandName === 'mod') {
            if (!isAuthorizedUser(interaction.user.id)) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }

            const subCommand = interaction.options.getSubcommand();

            if (subCommand === 'giveaway') {
                if (!isCommandEnabled('giveaways')) {
                    return interaction.reply({ content: '❌ The giveaway command is currently disabled.', ephemeral: true });
                }

                const prize = interaction.options.getString('prize');
                const duration = interaction.options.getInteger('duration') || 60;
                const hostId = interaction.user.id;

                // Check if prize is monetary and deduct from host account
                const prizeAmount = parseMoneyAmount(prize);
                if (prizeAmount > 0) {
                    const hostBalance = getMoney(hostId);
                    if (hostBalance < prizeAmount) {
                        return interaction.reply({ 
                            content: `❌ **Insufficient funds!**\nYou need **${formatNumberShort(prizeAmount)}** to create this giveaway, but you only have **${formatNumberShort(hostBalance)}**.\n\nSend money to the bot in Minecraft to add funds to your account.`, 
                            ephemeral: true 
                        });
                    }

                    // Deduct the prize amount from host's account
                    userMoney.set(hostId, hostBalance - prizeAmount);
                    saveUserMoney();
                    console.log(`[GIVEAWAY] Deducted ${formatNumberShort(prizeAmount)} from ${interaction.user.username}'s account for giveaway`);
                }

                await interaction.deferReply({ ephemeral: false }); // Make the initial reply visible

                const giveawayEmbed = new EmbedBuilder()
                    .setColor('#FFD700')
                    .setTitle('🎉 GIVEAWAY! 🎉')
                    .setDescription(`**Prize:** ${prize}`)
                    .addFields([
                        { name: '⏰ Duration', value: `${duration} minutes`, inline: true },
                        { name: '🎯 How to Enter', value: 'React with 🎉', inline: true },
                        { name: '📅 Ends', value: `<t:${Math.floor((Date.now() + duration * 60000) / 1000)}:R>`, inline: true },
                        { name: '💰 Prize System', value: 'Winners with linked accounts get money added automatically!', inline: false }
                    ])
                    .setFooter({ text: `Started by ${interaction.user.username}` })
                    .setTimestamp();

                const giveawayMessage = await interaction.editReply({ embeds: [giveawayEmbed] });
                await giveawayMessage.react('🎉');

                // Store giveaway data
                activeGiveaways.set(giveawayMessage.id, {
                    prize: prize,
                    duration: duration,
                    startTime: new Date(),
                    endTime: new Date(Date.now() + duration * 60000),
                    channelId: interaction.channel.id,
                    guildId: interaction.guild.id,
                    hostId: interaction.user.id
                });

                saveGiveaways();

                // Schedule giveaway end
                setTimeout(() => {
                    endGiveaway(giveawayMessage.id, interaction.guild.id);
                }, duration * 60000);

                console.log(`[GIVEAWAY] Started giveaway: ${prize} for ${duration} minutes`);

            } else if (subCommand === 'end') {
                const messageId = interaction.options.getString('message_id');

                if (!activeGiveaways.has(messageId)) {
                    return interaction.reply({ content: '❌ Giveaway not found or already ended.', ephemeral: true });
                }

                await interaction.deferReply({ ephemeral: true });
                await endGiveaway(messageId, interaction.guild.id);
                await interaction.editReply({ content: '✅ Giveaway ended successfully!', ephemeral: true });

            } else if (subCommand === 'reroll') {
                const messageId = interaction.options.getString('message_id');

                await interaction.deferReply({ ephemeral: true });

                try {
                    await rerollGiveaway(messageId, interaction.guild.id);
                    await interaction.editReply({ content: '✅ Giveaway rerolled successfully!', ephemeral: true });
                } catch (err) {
                    console.error('[GIVEAWAY] Error rerolling:', err.message);
                    await interaction.editReply({ content: '❌ Error rerolling giveaway. Make sure the message ID is correct.', ephemeral: true });
                }

            } else if (subCommand === 'stop') {
                const messageId = interaction.options.getString('message_id');

                if (!activeGiveaways.has(messageId)) {
                    return interaction.reply({ content: '❌ Giveaway not found or already ended.', ephemeral: true });
                }

                const giveaway = activeGiveaways.get(messageId);

                try {
                    const channel = interaction.guild.channels.cache.get(giveaway.channelId);
                    if (channel) {
                        const message = await channel.messages.fetch(messageId);
                        if (message) {
                            const stopEmbed = new EmbedBuilder()
                                .setColor('#FF0000')
                                .setTitle('🛑 Giveaway Stopped')
                                .setDescription(`**Prize:** ${giveaway.prize}\n**Status:** Cancelled by moderator`)
                                .setTimestamp();

                            await message.edit({
                                content: `${message.content}\n\n**CANCELLED**`,
                                embeds: [stopEmbed]
                            });
                        }
                    }

                    activeGiveaways.delete(messageId);
                    saveGiveaways();

                    await interaction.reply({ content: '✅ Giveaway stopped and cancelled successfully!', ephemeral: true });
                } catch (err) {
                    console.error('[GIVEAWAY] Error stopping giveaway:', err.message);
                    await interaction.reply({ content: '❌ Error stopping giveaway. Make sure the message ID is correct.', ephemeral: true });
                }
            }

        } else if (commandName === 'stats') {
            console.log(`[DISCORD_CMD] /stats command received from ${interaction.user.tag}.`);
            if (!isAuthorizedUser(interaction.user.id)) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }

            if (!bot || !bot.player) {
                return interaction.reply({ content: 'Minecraft bot is not online. Please wait for the bot to connect.', ephemeral: true });
            }

            const username = interaction.options.getString('username');

            await interaction.deferReply({ ephemeral: true });

            try {
                // Send /bal command to Minecraft
                bot.chat(`/bal ${username}`);
                console.log(`[STATS] Sent /bal ${username} command to Minecraft`);

                await interaction.editReply({
                    content: `✅ **Balance check sent for: ${username}**\nSent \`/bal ${username}\` command to Minecraft. Check the chat relay for the response.`
                });

            } catch (error) {
                console.error('[STATS] Error during stats command:', error.message);
                await interaction.editReply({
                    content: '❌ **Error checking player stats.**\nPlease try again.'
                });
            }

        } else if (commandName === 'payout') {
            console.log(`[DISCORD_CMD] /payout command received from ${interaction.user.tag}.`);
            if (!isAuthorizedUser(interaction.user.id)) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }

            if (!isCommandEnabled('payout')) {
                return interaction.reply({ content: '❌ The payout command is currently disabled.', ephemeral: true });
            }

            if (!bot || !bot.player || !bot.tasksInitialized) {
                return interaction.reply({ content: 'Minecraft bot is not online. Please wait for the bot to connect.', ephemeral: true });
            }

            const target = interaction.options.getString('target');
            const specificUser = interaction.options.getUser('user');

            await interaction.deferReply({ ephemeral: true });

            try {
                let payoutCount = 0;
                let totalPaidOut = 0;
                const payoutResults = [];

                if (target === 'all') {
                    // Payout all users with balance
                    for (const [discordId, balance] of userMoney.entries()) {
                        if (balance > 0) {
                            const linkedUsername = linkedUsers.get(discordId);
                            if (linkedUsername) {
                                const payCommand = `/pay ${linkedUsername} ${formatNumberShort(balance)}`;
                                bot.chat(payCommand);
                                console.log(`[PAYOUT] Paid ${formatNumberShort(balance)} to ${linkedUsername} (${discordId})`);

                                userMoney.set(discordId, 0);
                                payoutCount++;
                                totalPaidOut += balance;
                                payoutResults.push(`✅ ${linkedUsername}: ${formatNumberShort(balance)}`);

                                // Wait between payments
                                await new Promise(resolve => setTimeout(resolve, 2000));

                                // Notify user
                                try {
                                    const user = await discordClient.users.fetch(discordId);
                                    const payoutEmbed = new EmbedBuilder()
                                        .setColor('#00FF00')
                                        .setTitle('💰 Manual Payout Complete!')
                                        .setDescription(`Your account balance has been paid out by a moderator!`)
                                        .addFields([
                                            { name: '💵 Amount Paid', value: formatNumberShort(balance), inline: true },
                                            { name: '🎮 Minecraft Account', value: linkedUsername, inline: true }
                                        ])
                                        .setTimestamp();

                                    await user.send({ embeds: [payoutEmbed] });
                                } catch (dmErr) {
                                    console.log(`[PAYOUT] Could not DM user ${discordId}:`, dmErr.message);
                                }
                            } else {
                                payoutResults.push(`❌ <@${discordId}>: No linked account`);
                            }
                        }
                    }

                    saveUserMoney();

                    const summaryEmbed = new EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle('📊 Payout Summary - All Users')
                        .setDescription(payoutResults.length > 0 ? payoutResults.join('\n') : 'No users with balance found')
                        .addFields([
                            { name: '👥 Users Paid', value: payoutCount.toString(), inline: true },
                            { name: '💰 Total Amount', value: formatNumberShort(totalPaidOut), inline: true }
                        ])
                        .setTimestamp();

                    await interaction.editReply({ embeds: [summaryEmbed] });

                } else if (target === 'user') {
                    if (!specificUser) {
                        return interaction.editReply({ content: '❌ Please specify a user when using "Specific User" option.' });
                    }

                    const balance = getMoney(specificUser.id);
                    const linkedUsername = linkedUsers.get(specificUser.id);

                    if (balance <= 0) {
                        return interaction.editReply({ content: `❌ <@${specificUser.id}> has no balance to payout.` });
                    }

                    if (!linkedUsername) {
                        return interaction.editReply({ content: `❌ <@${specificUser.id}> has no linked Minecraft account.` });
                    }

                    const payCommand = `/pay ${linkedUsername} ${formatNumberShort(balance)}`;
                    bot.chat(payCommand);
                    console.log(`[PAYOUT] Paid ${formatNumberShort(balance)} to ${linkedUsername} (${specificUser.id})`);

                    userMoney.set(specificUser.id, 0);
                    saveUserMoney();

                    // Notify user
                    try {
                        const payoutEmbed = new EmbedBuilder()
                            .setColor('#00FF00')
                            .setTitle('💰 Manual Payout Complete!')
                            .setDescription(`Your account balance has been paid out by a moderator!`)
                            .addFields([
                                { name: '💵 Amount Paid', value: formatNumberShort(balance), inline: true },
                                { name: '🎮 Minecraft Account', value: linkedUsername, inline: true }
                            ])
                            .setTimestamp();

                        await specificUser.send({ embeds: [payoutEmbed] });
                    } catch (dmErr) {
                        console.log(`[PAYOUT] Could not DM user ${specificUser.id}:`, dmErr.message);
                    }

                    const summaryEmbed = new EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle('✅ Payout Complete')
                        .setDescription(`Successfully paid out to <@${specificUser.id}>`)
                        .addFields([
                            { name: '💵 Amount Paid', value: formatNumberShort(balance), inline: true },
                            { name: '🎮 Minecraft Account', value: linkedUsername, inline: true }
                        ])
                        .setTimestamp();

                    await interaction.editReply({ embeds: [summaryEmbed] });
                }

            } catch (error) {
                console.error('[PAYOUT] Error during payout command:', error.message);
                await interaction.editReply({
                    content: '❌ **Error processing payout.**\nPlease try again.'
                });
            }

        } else if (commandName === 'info') {
            const infoEmbed = new EmbedBuilder()
                .setColor('#3498DB')
                .setTitle('🎉 NeoSMP Bot Information')
                .setDescription('Here\'s everything you need to know about our rewards system!')
                .addFields([
                    { name: '🎯 Invite Rewards', value: '**500k** per person you invite to the server', inline: true },
                    { name: '🤝 Partner Rewards', value: '**5m** when you become a server partner', inline: true },
                    { name: '💰 Automatic Payouts', value: '**All account balances are automatically paid out daily at 10 AM UTC+1**', inline: false },
                    { name: '🔗 Important Requirements', value: 'You **must** use `/link <username>` to link your Minecraft account to claim all rewards!', inline: false },
                    { name: '💸 How to Add Funds', value: 'Send money to the bot in Minecraft to add funds to your Discord account balance', inline: false },
                    { name: '🎮 Bot Commands', value: '• `/account` - Check your balance\n• `/link <username>` - Link your Minecraft account\n• `/info` - Show this information', inline: false }
                ])
                .setFooter({ text: 'Make sure to link your account to receive all rewards!' })
                .setTimestamp();

            await interaction.reply({ embeds: [infoEmbed], ephemeral: false });

        } else if (commandName === 'coinflip') {
            if (!isCommandEnabled('coinflip')) {
                return interaction.reply({ content: '❌ The coinflip command is currently disabled.', ephemeral: true });
            }

            const betStr = interaction.options.getString('bet');
            const choice = interaction.options.getString('choice');
            const betAmount = parseMoneyAmount(betStr);

            if (betAmount <= 0) {
                return interaction.reply({ content: '❌ Please enter a valid bet amount.', ephemeral: true });
            }

            const currentBalance = getMoney(interaction.user.id);
            if (currentBalance < betAmount) {
                return interaction.reply({ 
                    content: `❌ Insufficient balance! You need **${formatNumberShort(betAmount)}** but only have **${formatNumberShort(currentBalance)}**.`, 
                    ephemeral: true 
                });
            }

            const result = Math.random() < 0.5 ? 'heads' : 'tails';
            const won = result === choice;
            
            let embed;
            if (won) {
                const winnings = betAmount;
                const taxRate = 0.10;
                const taxAmount = winnings * taxRate;
                const winningsAfterTax = winnings - taxAmount;
                
                addMoney(interaction.user.id, winningsAfterTax);
                
                embed = new EmbedBuilder()
                    .setColor('#00FF00')
                    .setTitle('🎰 Coinflip - YOU WON! 🎉')
                    .setDescription(`The coin landed on **${result}**!`)
                    .addFields([
                        { name: '💵 Bet Amount', value: formatNumberShort(betAmount), inline: true },
                        { name: '🏆 Winnings', value: formatNumberShort(winnings), inline: true },
                        { name: '🏦 Tax (10%)', value: formatNumberShort(taxAmount), inline: true },
                        { name: '✅ Net Winnings', value: formatNumberShort(winningsAfterTax), inline: true },
                        { name: '📊 New Balance', value: formatNumberShort(getMoney(interaction.user.id)), inline: true }
                    ])
                    .setTimestamp();
            } else {
                addMoney(interaction.user.id, -betAmount);
                
                embed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('🎰 Coinflip - You Lost 😢')
                    .setDescription(`The coin landed on **${result}**. Better luck next time!`)
                    .addFields([
                        { name: '💵 Bet Amount', value: formatNumberShort(betAmount), inline: true },
                        { name: '❌ Lost', value: formatNumberShort(betAmount), inline: true },
                        { name: '📊 New Balance', value: formatNumberShort(getMoney(interaction.user.id)), inline: true }
                    ])
                    .setTimestamp();
            }

            saveUserMoney();
            await interaction.reply({ embeds: [embed], ephemeral: false });

        } else if (commandName === 'slots') {
            if (!isCommandEnabled('slots')) {
                return interaction.reply({ content: '❌ The slots command is currently disabled.', ephemeral: true });
            }

            const betStr = interaction.options.getString('bet');
            const betAmount = parseMoneyAmount(betStr);

            if (betAmount <= 0) {
                return interaction.reply({ content: '❌ Please enter a valid bet amount.', ephemeral: true });
            }

            const currentBalance = getMoney(interaction.user.id);
            if (currentBalance < betAmount) {
                return interaction.reply({ 
                    content: `❌ Insufficient balance! You need **${formatNumberShort(betAmount)}** but only have **${formatNumberShort(currentBalance)}**.`, 
                    ephemeral: true 
                });
            }

            const symbols = ['🍒', '🍋', '🍊', '🍇', '💎', '7️⃣'];
            const slot1 = symbols[Math.floor(Math.random() * symbols.length)];
            const slot2 = symbols[Math.floor(Math.random() * symbols.length)];
            const slot3 = symbols[Math.floor(Math.random() * symbols.length)];

            let multiplier = 0;
            let resultText = '';

            if (slot1 === slot2 && slot2 === slot3) {
                if (slot1 === '7️⃣') {
                    multiplier = 10;
                    resultText = '🎰 **JACKPOT!** 🎰 Triple Sevens!';
                } else if (slot1 === '💎') {
                    multiplier = 5;
                    resultText = '💎 **TRIPLE DIAMONDS!** 💎';
                } else {
                    multiplier = 3;
                    resultText = '🎉 **TRIPLE MATCH!** 🎉';
                }
            } else if (slot1 === slot2 || slot2 === slot3 || slot1 === slot3) {
                multiplier = 1.5;
                resultText = '✨ **DOUBLE MATCH!** ✨';
            } else {
                multiplier = 0;
                resultText = '❌ **NO MATCH** ❌';
            }

            let embed;
            if (multiplier > 0) {
                const winnings = betAmount * multiplier;
                const taxRate = 0.10;
                const taxAmount = winnings * taxRate;
                const winningsAfterTax = winnings - taxAmount;
                
                addMoney(interaction.user.id, winningsAfterTax - betAmount);
                
                embed = new EmbedBuilder()
                    .setColor('#00FF00')
                    .setTitle('🎰 Slot Machine - YOU WON! 🎉')
                    .setDescription(`${slot1} ${slot2} ${slot3}\n\n${resultText}`)
                    .addFields([
                        { name: '💵 Bet Amount', value: formatNumberShort(betAmount), inline: true },
                        { name: '🎲 Multiplier', value: `x${multiplier}`, inline: true },
                        { name: '🏆 Gross Winnings', value: formatNumberShort(winnings), inline: true },
                        { name: '🏦 Tax (10%)', value: formatNumberShort(taxAmount), inline: true },
                        { name: '✅ Net Profit', value: formatNumberShort(winningsAfterTax - betAmount), inline: true },
                        { name: '📊 New Balance', value: formatNumberShort(getMoney(interaction.user.id)), inline: true }
                    ])
                    .setTimestamp();
            } else {
                addMoney(interaction.user.id, -betAmount);
                
                embed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('🎰 Slot Machine - You Lost 😢')
                    .setDescription(`${slot1} ${slot2} ${slot3}\n\n${resultText}`)
                    .addFields([
                        { name: '💵 Bet Amount', value: formatNumberShort(betAmount), inline: true },
                        { name: '❌ Lost', value: formatNumberShort(betAmount), inline: true },
                        { name: '📊 New Balance', value: formatNumberShort(getMoney(interaction.user.id)), inline: true }
                    ])
                    .setTimestamp();
            }

            saveUserMoney();
            await interaction.reply({ embeds: [embed], ephemeral: false });

        } else if (commandName === 'perms') {
            if (interaction.user.id !== DISCORD_OWNER_ID) {
                return interaction.reply({ content: 'Only the bot owner can use this command.', ephemeral: true });
            }

            const subCommand = interaction.options.getSubcommand();

            if (subCommand === 'user') {
                const action = interaction.options.getString('action');
                const targetUser = interaction.options.getUser('user');

                if (action === 'list') {
                    const authorizedList = AUTHORIZED_USERS
                        .filter(id => id !== DISCORD_OWNER_ID)
                        .map(id => `<@${id}>`)
                        .join('\n') || 'No additional authorized users';

                    const listEmbed = new EmbedBuilder()
                        .setColor('#3498DB')
                        .setTitle('👥 Authorized Users')
                        .setDescription(authorizedList)
                        .setFooter({ text: `Total: ${AUTHORIZED_USERS.length - 1} (excluding owner)` })
                        .setTimestamp();

                    return interaction.reply({ embeds: [listEmbed], ephemeral: true });
                }

                if (!targetUser) {
                    return interaction.reply({ content: '❌ Please specify a user.', ephemeral: true });
                }

                if (targetUser.id === DISCORD_OWNER_ID) {
                    return interaction.reply({ content: 'The bot owner is always authorized and cannot be modified.', ephemeral: true });
                }

                if (action === 'add') {
                    if (AUTHORIZED_USERS.includes(targetUser.id)) {
                        return interaction.reply({ content: `<@${targetUser.id}> is already authorized.`, ephemeral: true });
                    }

                    AUTHORIZED_USERS.push(targetUser.id);
                    saveAuthorizedUsers();

                    await interaction.reply({ 
                        content: `✅ **<@${targetUser.id}>** has been added to authorized users.`, 
                        ephemeral: true 
                    });

                } else if (action === 'remove') {
                    if (!AUTHORIZED_USERS.includes(targetUser.id)) {
                        return interaction.reply({ content: `<@${targetUser.id}> is not authorized.`, ephemeral: true });
                    }

                    AUTHORIZED_USERS = AUTHORIZED_USERS.filter(id => id !== targetUser.id);
                    saveAuthorizedUsers();

                    await interaction.reply({ 
                        content: `✅ **<@${targetUser.id}>** has been removed from authorized users.`, 
                        ephemeral: true 
                    });
                }

            } else if (subCommand === 'toggle') {
                const command = interaction.options.getString('command');
                const status = interaction.options.getString('status');

                const enabled = status === 'enable';
                commandToggles.set(command, enabled);
                saveCommandToggles();

                const toggleEmbed = new EmbedBuilder()
                    .setColor(enabled ? '#00FF00' : '#FF0000')
                    .setTitle('⚙️ Command Toggle Updated')
                    .setDescription(`The **${command}** command has been **${enabled ? 'enabled' : 'disabled'}**.`)
                    .setTimestamp();

                await interaction.reply({ embeds: [toggleEmbed], ephemeral: true });

            } else if (subCommand === 'view') {
                const togglesList = Array.from(commandToggles.entries())
                    .map(([cmd, enabled]) => `${enabled ? '✅' : '❌'} **${cmd}**`)
                    .join('\n');

                const viewEmbed = new EmbedBuilder()
                    .setColor('#3498DB')
                    .setTitle('⚙️ Command Toggles')
                    .setDescription(togglesList || 'No command toggles configured')
                    .setFooter({ text: 'Use /perms toggle to change settings' })
                    .setTimestamp();

                await interaction.reply({ embeds: [viewEmbed], ephemeral: true });
            }

        } else if (commandName === 'partner') {
            if (!discordClient || !discordClient.isReady()) {
                return interaction.reply({ content: 'Discord bot is not ready. Please try again in a moment.', ephemeral: true });
            }

            // Works in both DMs and guild channels
            await interaction.deferReply({ ephemeral: false });

            const partnerMessages = await fetchPartnerMessages();

            const partnerEmbed = new EmbedBuilder()
                .setColor('#8E44AD')
                .setTitle('🤝 Partner Channel Messages')
                .setDescription(partnerMessages || 'Could not fetch partner messages.')
                .setTimestamp();

            await interaction.editReply({ embeds: [partnerEmbed] });
        }
    } catch (error) {
        console.error(`[DISCORD_FATAL] An error occurred during interaction handling:`, error);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: 'An unexpected error occurred while processing your command.', ephemeral: true }).catch(e => {});
        } else {
            await interaction.reply({ content: 'An unexpected error occurred while processing your command.', ephemeral: true }).catch(e => {});
        }
    }
});

// Graceful shutdown handler
const gracefulShutdown = async (signal) => {
  console.log(`[PROCESS] Received ${signal}. Shutting down...`);
  manualStop = true;

  if (bot) {
    console.log('[BOT] Quitting Minecraft bot...');
    if(bot.tasksInitialized) bot.tasksInitialized = false;
    stopAntiAFK();
    bot.quit(`Bot shutting down: ${signal}.`);
  }

  // Shutdown moderation bot
  if (moderationBotProcess) {
    console.log('[MOD_BOT] Stopping moderation bot...');
    moderationBotProcess.kill('SIGTERM');
    moderationBotProcess = null;
  }

  setTimeout(async () => {
    if (discordClient) {
      console.log('[DISCORD] Destroying client...');
      discordClient.destroy();
    }

    setTimeout(() => {
      console.log('[PROCESS] Forcing exit.');
      process.exit(0);
    }, 2000);
  }, 3000);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  console.error('[FATAL_ERROR] UNCAUGHT EXCEPTION:', error);
  try {
    if (bot) {
      console.log('[RECOVERY] Attempting to clean up bot after uncaught exception...');
      cleanupBot();
    }

    console.log('[RECOVERY] Attempting recovery from uncaught exception...');
    setTimeout(() => {
      if (!manualStop) {
        console.log('[RECOVERY] Creating new bot instance after uncaught exception...');
        createBot();
      }
    }, 5000);
  } catch (recoveryError) {
    console.error('[RECOVERY] Recovery attempt failed:', recoveryError);
    gracefulShutdown('uncaughtException');
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL_ERROR] UNHANDLED PROMISE REJECTION at:', promise, 'reason:', reason);
});

// Start moderation bot as a child process
let moderationBotProcess = null;

function startModerationBot() {
  if (moderationBotProcess) {
    console.log('[MOD_BOT] Moderation bot already running');
    return;
  }

  console.log('[MOD_BOT] Starting moderation bot...');
  
  moderationBotProcess = spawn('node', ['moderation-bot.js'], {
    stdio: 'inherit',
    env: process.env
  });

  moderationBotProcess.on('error', (err) => {
    console.error('[MOD_BOT] Failed to start moderation bot:', err.message);
  });

  moderationBotProcess.on('exit', (code, signal) => {
    console.log(`[MOD_BOT] Moderation bot exited with code ${code} and signal ${signal}`);
    moderationBotProcess = null;
    
    // Auto-restart moderation bot if it crashes (unless manual shutdown)
    if (!manualStop && code !== 0) {
      console.log('[MOD_BOT] Restarting moderation bot in 5 seconds...');
      setTimeout(() => startModerationBot(), 5000);
    }
  });

  console.log('[MOD_BOT] Moderation bot process started');
}

// Initialize Discord client
async function initializeDiscord() {
  try {
    // Load all data before starting Discord
    console.log('[DATABASE] Loading all data...');
    loadUserMoney();
    loadLinkedUsers();
    loadGiveaways();
    loadAuthorizedUsers();
    loadCommandToggles();
    console.log('[DATABASE] All data loaded successfully');

    await discordClient.login(DISCORD_TOKEN);
    console.log('[DISCORD] Successfully logged in');
    
    // Start moderation bot after main bot is ready
    startModerationBot();
  } catch (err) {
    console.error(`[DISCORD_FATAL] Login failed: ${err.message}`);
    setTimeout(() => {
      process.exit(1);
    }, 10000);
  }
}

initializeDiscord();

// Enhanced connection monitoring
const CONNECTION_CHECK_INTERVAL = 120000; // Check every 2 minutes

setInterval(() => {
  try {
    if (reconnecting || manualStop) {
      return;
    }

    if (connectionAttempts > 0 && (Date.now() - (lastSuccessfulConnection || Date.now())) < 180000) {
      return;
    }

    if (bot && bot.player && bot.tasksInitialized) {
      if (bot._client && bot._client.socket) {
        if (bot._client.socket.destroyed || bot._client.socket.readyState !== 'open') {
          console.warn('[CONNECTION_MONITOR] Dead connection detected, attempting reconnect...');
          if (!reconnecting && !manualStop) {
            cleanupBot();
            bot = null;
            setTimeout(() => attemptReconnect(), 5000);
          }
        }
      }
    } else if (!bot && !reconnecting && !manualStop && connectionAttempts === 0) {
      console.log('[CONNECTION_MONITOR] No bot instance detected, attempting to create one...');
      createBot();
    }
  } catch (err) {
    console.error('[CONNECTION_MONITOR] Error in connection monitoring:', err.message);
  }
}, CONNECTION_CHECK_INTERVAL);

// Daily payout system - check every minute for 10 AM UTC+1
let lastPayoutDate = new Date().toDateString();

setInterval(async () => {
  try {
    const now = new Date();
    const utcPlus1 = new Date(now.getTime() + (1 * 60 * 60 * 1000)); // UTC+1
    const currentDateString = utcPlus1.toDateString();

    // Check if it's 10 AM UTC+1 and we haven't paid out today
    if (utcPlus1.getHours() === 10 && utcPlus1.getMinutes() === 0 && lastPayoutDate !== currentDateString) {
      console.log('[PAYOUT] Starting daily automated payouts at 10 AM UTC+1...');
      lastPayoutDate = currentDateString;

      if (!bot || !bot.player || !bot.tasksInitialized) {
        console.log('[PAYOUT] Bot not ready for payouts, skipping...');
        return;
      }

      let payoutCount = 0;
      let totalPaidOut = 0;

      // Process all users with money
      for (const [discordId, balance] of userMoney.entries()) {
        if (balance > 0) {
          const linkedUsername = linkedUsers.get(discordId);
          if (linkedUsername) {
            try {
              const payCommand = `/pay ${linkedUsername} ${formatNumberShort(balance)}`;
              bot.chat(payCommand);
              console.log(`[PAYOUT] Paid ${formatNumberShort(balance)} to ${linkedUsername} (${discordId})`);

              // Reset their balance to 0
              userMoney.set(discordId, 0);
              payoutCount++;
              totalPaidOut += balance;

              // Wait between payments to avoid spam
              await new Promise(resolve => setTimeout(resolve, 2000));

              // Notify user
              try {
                const user = await discordClient.users.fetch(discordId);
                const payoutEmbed = new EmbedBuilder()
                  .setColor('#00FF00')
                  .setTitle('💰 Daily Payout Complete!')
                  .setDescription(`Your account balance has been automatically paid out!`)
                  .addFields([
                    { name: '💵 Amount Paid', value: formatNumberShort(balance), inline: true },
                    { name: '🎮 Minecraft Account', value: linkedUsername, inline: true },
                    { name: '⏰ Payout Time', value: '10:00 AM UTC+1', inline: true }
                  ])
                  .setTimestamp();

                await user.send({ embeds: [payoutEmbed] });
              } catch (dmErr) {
                console.log(`[PAYOUT] Could not DM user ${discordId}:`, dmErr.message);
              }

            } catch (err) {
              console.error(`[PAYOUT] Error paying out to ${linkedUsername}:`, err.message);
            }
          } else {
            console.log(`[PAYOUT] Skipping payout for ${discordId} - no linked Minecraft account`);
          }
        }
      }

      saveUserMoney();
      console.log(`[PAYOUT] Daily payout complete! Paid out ${formatNumberShort(totalPaidOut)} to ${payoutCount} users`);

      // Send summary to status channel
      if (payoutCount > 0) {
        try {
          const statusChannel = discordClient.channels.cache.get(DISCORD_STATUS_CHANNEL_ID);
          if (statusChannel) {
            const summaryEmbed = new EmbedBuilder()
              .setColor('#00FF00')
              .setTitle('📊 Daily Payout Summary')
              .setDescription(`Automated daily payouts completed successfully!`)
              .addFields([
                { name: '👥 Users Paid', value: payoutCount.toString(), inline: true },
                { name: '💰 Total Amount', value: formatNumberShort(totalPaidOut), inline: true },
                { name: '⏰ Payout Time', value: '10:00 AM UTC+1', inline: true }
              ])
              .setTimestamp();

            await statusChannel.send({ embeds: [summaryEmbed] });
          }
        } catch (err) {
          console.error('[PAYOUT] Error sending summary to status channel:', err.message);
        }
      }
    }
  } catch (err) {
    console.error('[PAYOUT] Error in daily payout system:', err.message);
  }
}, 60000); // Check every minute

// Clean up expired data every 5 minutes
setInterval(() => {
  try {
    // Clean up old giveaways
    const now = new Date();
    let cleanedCount = 0;

    activeGiveaways.forEach((giveaway, id) => {
      if (giveaway.endTime < now) {
        activeGiveaways.delete(id);
        cleanedCount++;
      }
    });

    if (cleanedCount > 0) {
      console.log(`[CLEANUP] Removed ${cleanedCount} expired giveaways`);
      saveGiveaways();
    }

  } catch (err) {
    console.error('[CLEANUP] Error during cleanup:', err.message);
  }
}, 300000); // 5 minutes