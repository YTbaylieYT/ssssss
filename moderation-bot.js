
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, PermissionFlagsBits, ChannelType, Events, ModalBuilder, TextInputBuilder, TextInputStyle, AuditLogEvent } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Configuration from environment variables
const DISCORD_TOKEN = process.env.MOD_BOT_TOKEN;
const GUILD_ID = process.env.MOD_BOT_GUILD_ID;

// Log Channels
const LOG_CHANNELS = {
  MESSAGE_DELETE: process.env.LOG_MESSAGE_DELETE_CHANNEL,
  MESSAGE_EDIT: process.env.LOG_MESSAGE_EDIT_CHANNEL,
  TIMEOUT: process.env.LOG_TIMEOUT_CHANNEL,
  JOIN: process.env.LOG_JOIN_CHANNEL,
  LEAVE: process.env.LOG_LEAVE_CHANNEL,
  ROLE: process.env.LOG_ROLE_CHANNEL,
  SERVER_UPDATE: process.env.LOG_SERVER_UPDATE_CHANNEL,
  BAN: process.env.LOG_BAN_CHANNEL,
  KICK: process.env.LOG_KICK_CHANNEL,
  NICKNAME: process.env.LOG_NICKNAME_CHANNEL,
  AVATAR: process.env.LOG_AVATAR_CHANNEL,
  VOICE: process.env.LOG_VOICE_CHANNEL,
  TICKET: process.env.LOG_TICKET_CHANNEL
};

// Ticket Configuration
const TICKET_CONFIG = {
  CATEGORY_ID: process.env.TICKET_CATEGORY_ID,
  PANEL_CHANNEL: process.env.TICKET_PANEL_CHANNEL,
  GENERAL_SUPPORT: {
    ROLES: (process.env.TICKET_GENERAL_SUPPORT_ROLES || '').split(',').filter(r => r),
    CATEGORY: process.env.TICKET_GENERAL_SUPPORT_CATEGORY
  },
  GIVEAWAY_CLAIM: {
    ROLES: (process.env.TICKET_GIVEAWAY_CLAIM_ROLES || '').split(',').filter(r => r),
    CATEGORY: process.env.TICKET_GIVEAWAY_CLAIM_CATEGORY
  },
  STAFF_REPORT: {
    ROLES: (process.env.TICKET_STAFF_REPORT_ROLES || '').split(',').filter(r => r),
    CATEGORY: process.env.TICKET_STAFF_REPORT_CATEGORY
  },
  INVITE_REWARD: {
    ROLES: (process.env.TICKET_INVITE_REWARD_ROLES || '').split(',').filter(r => r),
    CATEGORY: process.env.TICKET_INVITE_REWARD_CATEGORY
  }
};

// Active tickets storage
const TICKETS_FILE = path.join(__dirname, 'active_tickets.json');
let activeTickets = new Map();

// Load active tickets
function loadTickets() {
  try {
    if (fs.existsSync(TICKETS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TICKETS_FILE, 'utf8'));
      activeTickets = new Map(Object.entries(data));
      console.log(`[TICKETS] Loaded ${activeTickets.size} active tickets`);
    }
  } catch (err) {
    console.error('[TICKETS] Error loading tickets:', err);
  }
}

// Save active tickets
function saveTickets() {
  try {
    fs.writeFileSync(TICKETS_FILE, JSON.stringify(Object.fromEntries(activeTickets), null, 2));
  } catch (err) {
    console.error('[TICKETS] Error saving tickets:', err);
  }
}

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.MessageContent
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.GuildMember,
    Partials.User
  ]
});

// Message cache for deleted/edited messages
const messageCache = new Map();
const MAX_CACHE_SIZE = 10000;

// Ready event
client.once(Events.ClientReady, async () => {
  console.log(`[MOD BOT] Logged in as ${client.user.tag}`);
  loadTickets();
  
  // Create ticket panel
  await createTicketPanel();
});

// Create ticket panel
async function createTicketPanel() {
  if (!TICKET_CONFIG.PANEL_CHANNEL) return;
  
  try {
    const channel = await client.channels.fetch(TICKET_CONFIG.PANEL_CHANNEL);
    if (!channel) return;
    
    // Clear old messages
    const messages = await channel.messages.fetch({ limit: 10 });
    await channel.bulkDelete(messages.filter(m => m.author.id === client.user.id));
    
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🎫 Support Ticket System')
      .setDescription('Select a ticket type from the dropdown menu below to create a support ticket.\n\nOur team will assist you as soon as possible!')
      .addFields([
        { name: '📋 General Support', value: 'General questions and assistance', inline: true },
        { name: '🎁 Giveaway Claim', value: 'Claim your giveaway prizes', inline: true },
        { name: '⚠️ Staff Report', value: 'Report staff misconduct', inline: true },
        { name: '🎉 Invite Reward Claim', value: 'Claim invite rewards', inline: true }
      ])
      .setFooter({ text: 'Select a ticket type to get started' })
      .setTimestamp();
    
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('ticket_type')
      .setPlaceholder('Select ticket type...')
      .addOptions([
        new StringSelectMenuOptionBuilder()
          .setLabel('General Support')
          .setDescription('Get help with general questions')
          .setValue('general_support')
          .setEmoji('📋'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Giveaway Claim')
          .setDescription('Claim your giveaway prize')
          .setValue('giveaway_claim')
          .setEmoji('🎁'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Staff Report')
          .setDescription('Report a staff member')
          .setValue('staff_report')
          .setEmoji('⚠️'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Invite Reward Claim')
          .setDescription('Claim your invite rewards')
          .setValue('invite_reward')
          .setEmoji('🎉')
      ]);
    
    const row = new ActionRowBuilder().addComponents(selectMenu);
    
    await channel.send({ embeds: [embed], components: [row] });
    console.log('[TICKETS] Created ticket panel');
  } catch (err) {
    console.error('[TICKETS] Error creating ticket panel:', err);
  }
}

// Message cache handler
client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return;
  
  messageCache.set(message.id, {
    content: message.content,
    author: message.author,
    channel: message.channel,
    attachments: message.attachments.map(a => a.url),
    embeds: message.embeds,
    createdAt: message.createdAt
  });
  
  // Limit cache size
  if (messageCache.size > MAX_CACHE_SIZE) {
    const firstKey = messageCache.keys().next().value;
    messageCache.delete(firstKey);
  }
});

// Message delete logging
client.on(Events.MessageDelete, async (message) => {
  if (!LOG_CHANNELS.MESSAGE_DELETE) return;
  
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNELS.MESSAGE_DELETE);
    if (!logChannel) return;
    
    const cached = messageCache.get(message.id) || {};
    const content = message.content || cached.content || '*No content cached*';
    const author = message.author || cached.author;
    
    if (!author || author.bot) return;
    
    const embed = new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('🗑️ Message Deleted')
      .setDescription(`**Author:** ${author}\n**Channel:** ${message.channel}\n**Content:**\n${content}`)
      .addFields([
        { name: 'Message ID', value: message.id, inline: true },
        { name: 'Channel', value: `${message.channel}`, inline: true },
        { name: 'Author', value: `${author}`, inline: true }
      ])
      .setTimestamp();
    
    if (cached.attachments?.length > 0) {
      embed.addFields({ name: 'Attachments', value: cached.attachments.join('\n') });
    }
    
    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[LOG] Error logging message delete:', err);
  }
});

// Message edit logging
client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  if (!LOG_CHANNELS.MESSAGE_EDIT) return;
  if (!oldMessage.content || !newMessage.content) return;
  if (oldMessage.content === newMessage.content) return;
  if (newMessage.author?.bot) return;
  
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNELS.MESSAGE_EDIT);
    if (!logChannel) return;
    
    const embed = new EmbedBuilder()
      .setColor('#FEE75C')
      .setTitle('✏️ Message Edited')
      .addFields([
        { name: 'Author', value: `${newMessage.author}`, inline: true },
        { name: 'Channel', value: `${newMessage.channel}`, inline: true },
        { name: 'Message ID', value: newMessage.id, inline: true },
        { name: 'Before', value: oldMessage.content.substring(0, 1024) || '*No content*' },
        { name: 'After', value: newMessage.content.substring(0, 1024) || '*No content*' },
        { name: 'Jump to Message', value: `[Click here](${newMessage.url})` }
      ])
      .setTimestamp();
    
    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[LOG] Error logging message edit:', err);
  }
});

// Member join logging
client.on(Events.GuildMemberAdd, async (member) => {
  if (!LOG_CHANNELS.JOIN) return;
  
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNELS.JOIN);
    if (!logChannel) return;
    
    const accountAge = Date.now() - member.user.createdTimestamp;
    const accountAgeDays = Math.floor(accountAge / (1000 * 60 * 60 * 24));
    
    const embed = new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('📥 Member Joined')
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
      .addFields([
        { name: 'User', value: `${member.user} (${member.user.tag})`, inline: true },
        { name: 'User ID', value: member.id, inline: true },
        { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Account Age', value: `${accountAgeDays} days`, inline: true },
        { name: 'Member Count', value: `${member.guild.memberCount}`, inline: true }
      ])
      .setTimestamp();
    
    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[LOG] Error logging member join:', err);
  }
});

// Member leave logging
client.on(Events.GuildMemberRemove, async (member) => {
  if (!LOG_CHANNELS.LEAVE) return;
  
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNELS.LEAVE);
    if (!logChannel) return;
    
    const roles = member.roles.cache
      .filter(role => role.id !== member.guild.id)
      .map(role => role.toString())
      .join(', ') || 'None';
    
    const embed = new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('📤 Member Left')
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
      .addFields([
        { name: 'User', value: `${member.user} (${member.user.tag})`, inline: true },
        { name: 'User ID', value: member.id, inline: true },
        { name: 'Joined Server', value: member.joinedAt ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Unknown', inline: true },
        { name: 'Roles', value: roles.substring(0, 1024) },
        { name: 'Member Count', value: `${member.guild.memberCount}`, inline: true }
      ])
      .setTimestamp();
    
    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[LOG] Error logging member leave:', err);
  }
});

// Role update logging
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  if (!LOG_CHANNELS.ROLE) return;
  
  try {
    const oldRoles = oldMember.roles.cache;
    const newRoles = newMember.roles.cache;
    
    const addedRoles = newRoles.filter(role => !oldRoles.has(role.id));
    const removedRoles = oldRoles.filter(role => !newRoles.has(role.id));
    
    if (addedRoles.size === 0 && removedRoles.size === 0) {
      // Check for nickname change
      if (oldMember.nickname !== newMember.nickname && LOG_CHANNELS.NICKNAME) {
        const nickChannel = await client.channels.fetch(LOG_CHANNELS.NICKNAME);
        if (nickChannel) {
          const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('✏️ Nickname Changed')
            .addFields([
              { name: 'User', value: `${newMember.user}`, inline: true },
              { name: 'User ID', value: newMember.id, inline: true },
              { name: 'Old Nickname', value: oldMember.nickname || '*None*', inline: true },
              { name: 'New Nickname', value: newMember.nickname || '*None*', inline: true }
            ])
            .setTimestamp();
          
          await nickChannel.send({ embeds: [embed] });
        }
      }
      return;
    }
    
    const logChannel = await client.channels.fetch(LOG_CHANNELS.ROLE);
    if (!logChannel) return;
    
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('👤 Member Roles Updated')
      .addFields([
        { name: 'User', value: `${newMember.user}`, inline: true },
        { name: 'User ID', value: newMember.id, inline: true }
      ])
      .setTimestamp();
    
    if (addedRoles.size > 0) {
      embed.addFields({ name: '➕ Added Roles', value: addedRoles.map(r => r.toString()).join(', ') });
    }
    
    if (removedRoles.size > 0) {
      embed.addFields({ name: '➖ Removed Roles', value: removedRoles.map(r => r.toString()).join(', ') });
    }
    
    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[LOG] Error logging role update:', err);
  }
});

// User avatar update logging
client.on(Events.UserUpdate, async (oldUser, newUser) => {
  if (!LOG_CHANNELS.AVATAR) return;
  if (oldUser.avatar === newUser.avatar) return;
  
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNELS.AVATAR);
    if (!logChannel) return;
    
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🖼️ Avatar Updated')
      .addFields([
        { name: 'User', value: `${newUser} (${newUser.tag})`, inline: true },
        { name: 'User ID', value: newUser.id, inline: true }
      ])
      .setThumbnail(oldUser.displayAvatarURL({ dynamic: true, size: 256 }))
      .setImage(newUser.displayAvatarURL({ dynamic: true, size: 256 }))
      .setTimestamp();
    
    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[LOG] Error logging avatar update:', err);
  }
});

// Ban logging
client.on(Events.GuildBanAdd, async (ban) => {
  if (!LOG_CHANNELS.BAN) return;
  
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNELS.BAN);
    if (!logChannel) return;
    
    // Fetch audit logs for ban reason
    const auditLogs = await ban.guild.fetchAuditLogs({
      type: AuditLogEvent.MemberBanAdd,
      limit: 1
    });
    
    const banLog = auditLogs.entries.first();
    const executor = banLog?.executor;
    const reason = banLog?.reason || '*No reason provided*';
    
    const embed = new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('🔨 Member Banned')
      .setThumbnail(ban.user.displayAvatarURL({ dynamic: true }))
      .addFields([
        { name: 'User', value: `${ban.user} (${ban.user.tag})`, inline: true },
        { name: 'User ID', value: ban.user.id, inline: true },
        { name: 'Banned By', value: executor ? `${executor}` : 'Unknown', inline: true },
        { name: 'Reason', value: reason }
      ])
      .setTimestamp();
    
    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[LOG] Error logging ban:', err);
  }
});

// Kick logging
client.on(Events.GuildAuditLogEntryCreate, async (auditLog) => {
  if (auditLog.action !== AuditLogEvent.MemberKick) return;
  if (!LOG_CHANNELS.KICK) return;
  
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNELS.KICK);
    if (!logChannel) return;
    
    const embed = new EmbedBuilder()
      .setColor('#FEE75C')
      .setTitle('👢 Member Kicked')
      .addFields([
        { name: 'User', value: `${auditLog.target} (${auditLog.target.tag})`, inline: true },
        { name: 'User ID', value: auditLog.targetId, inline: true },
        { name: 'Kicked By', value: `${auditLog.executor}`, inline: true },
        { name: 'Reason', value: auditLog.reason || '*No reason provided*' }
      ])
      .setTimestamp();
    
    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[LOG] Error logging kick:', err);
  }
});

// Timeout logging
client.on(Events.GuildAuditLogEntryCreate, async (auditLog) => {
  if (auditLog.action !== AuditLogEvent.MemberUpdate) return;
  if (!auditLog.changes?.find(c => c.key === 'communication_disabled_until')) return;
  if (!LOG_CHANNELS.TIMEOUT) return;
  
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNELS.TIMEOUT);
    if (!logChannel) return;
    
    const change = auditLog.changes.find(c => c.key === 'communication_disabled_until');
    
    if (change.new) {
      const embed = new EmbedBuilder()
        .setColor('#FEE75C')
        .setTitle('⏰ Member Timed Out')
        .addFields([
          { name: 'User', value: `${auditLog.target}`, inline: true },
          { name: 'User ID', value: auditLog.targetId, inline: true },
          { name: 'Timed Out By', value: `${auditLog.executor}`, inline: true },
          { name: 'Until', value: `<t:${Math.floor(new Date(change.new).getTime() / 1000)}:F>`, inline: true },
          { name: 'Reason', value: auditLog.reason || '*No reason provided*' }
        ])
        .setTimestamp();
      
      await logChannel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error('[LOG] Error logging timeout:', err);
  }
});

// Voice state logging
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (!LOG_CHANNELS.VOICE) return;
  
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNELS.VOICE);
    if (!logChannel) return;
    
    let embed;
    
    if (!oldState.channel && newState.channel) {
      // User joined a voice channel
      embed = new EmbedBuilder()
        .setColor('#57F287')
        .setTitle('🔊 Voice Channel Join')
        .addFields([
          { name: 'User', value: `${newState.member}`, inline: true },
          { name: 'Channel', value: `${newState.channel}`, inline: true }
        ])
        .setTimestamp();
    } else if (oldState.channel && !newState.channel) {
      // User left a voice channel
      embed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle('🔇 Voice Channel Leave')
        .addFields([
          { name: 'User', value: `${oldState.member}`, inline: true },
          { name: 'Channel', value: `${oldState.channel}`, inline: true }
        ])
        .setTimestamp();
    } else if (oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id) {
      // User moved to a different voice channel
      embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🔄 Voice Channel Move')
        .addFields([
          { name: 'User', value: `${newState.member}`, inline: true },
          { name: 'From', value: `${oldState.channel}`, inline: true },
          { name: 'To', value: `${newState.channel}`, inline: true }
        ])
        .setTimestamp();
    }
    
    if (embed) {
      await logChannel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error('[LOG] Error logging voice state:', err);
  }
});

// Ticket type selection handler
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId !== 'ticket_type') return;
  
  const ticketType = interaction.values[0];
  
  // Check if user already has an open ticket
  const existingTicket = Array.from(activeTickets.values()).find(t => t.userId === interaction.user.id && !t.closed);
  if (existingTicket) {
    return interaction.reply({ 
      content: '❌ You already have an open ticket! Please close your current ticket before opening a new one.',
      ephemeral: true 
    });
  }
  
  await interaction.deferReply({ ephemeral: true });
  
  try {
    await createTicket(interaction, ticketType);
  } catch (err) {
    console.error('[TICKETS] Error creating ticket:', err);
    await interaction.editReply({ content: '❌ An error occurred while creating your ticket. Please try again.' });
  }
});

// Create ticket
async function createTicket(interaction, ticketType) {
  const guild = interaction.guild;
  const member = interaction.member;
  
  let config, categoryId, ticketName, emoji;
  
  switch (ticketType) {
    case 'general_support':
      config = TICKET_CONFIG.GENERAL_SUPPORT;
      categoryId = config.CATEGORY;
      ticketName = 'general-support';
      emoji = '📋';
      break;
    case 'giveaway_claim':
      config = TICKET_CONFIG.GIVEAWAY_CLAIM;
      categoryId = config.CATEGORY;
      ticketName = 'giveaway-claim';
      emoji = '🎁';
      break;
    case 'staff_report':
      config = TICKET_CONFIG.STAFF_REPORT;
      categoryId = config.CATEGORY;
      ticketName = 'staff-report';
      emoji = '⚠️';
      break;
    case 'invite_reward':
      config = TICKET_CONFIG.INVITE_REWARD;
      categoryId = config.CATEGORY;
      ticketName = 'invite-reward';
      emoji = '🎉';
      break;
  }
  
  // Create ticket channel
  const ticketChannel = await guild.channels.create({
    name: `${emoji}${ticketName}-${member.user.username}`,
    type: ChannelType.GuildText,
    parent: categoryId,
    permissionOverwrites: [
      {
        id: guild.id,
        deny: [PermissionFlagsBits.ViewChannel]
      },
      {
        id: member.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
      },
      ...config.ROLES.map(roleId => ({
        id: roleId,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
      }))
    ]
  });
  
  // Create ticket embed
  const ticketEmbed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle(`${emoji} Support Ticket`)
    .setDescription(`Welcome ${member}!\n\nPlease describe your issue and our support team will assist you shortly.`)
    .addFields([
      { name: 'Ticket Type', value: ticketType.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '), inline: true },
      { name: 'Status', value: '🟢 Open', inline: true }
    ])
    .setTimestamp();
  
  // Ticket control buttons
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_claim')
        .setLabel('Claim')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('✋'),
      new ButtonBuilder()
        .setCustomId('ticket_close_request')
        .setLabel('Close Request')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('📝'),
      new ButtonBuilder()
        .setCustomId('ticket_close')
        .setLabel('Close')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒')
    );
  
  await ticketChannel.send({ 
    content: `${member} ${config.ROLES.map(r => `<@&${r}>`).join(' ')}`,
    embeds: [ticketEmbed], 
    components: [row] 
  });
  
  // Store ticket data
  activeTickets.set(ticketChannel.id, {
    channelId: ticketChannel.id,
    userId: member.id,
    type: ticketType,
    claimed: false,
    claimedBy: null,
    createdAt: Date.now(),
    closed: false,
    messages: []
  });
  saveTickets();
  
  await interaction.editReply({ content: `✅ Ticket created! ${ticketChannel}` });
}

// Ticket button handlers
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  
  const ticketData = activeTickets.get(interaction.channel.id);
  if (!ticketData) return;
  
  if (interaction.customId === 'ticket_claim') {
    if (ticketData.claimed) {
      return interaction.reply({ content: '❌ This ticket has already been claimed!', ephemeral: true });
    }
    
    ticketData.claimed = true;
    ticketData.claimedBy = interaction.user.id;
    saveTickets();
    
    const embed = new EmbedBuilder()
      .setColor('#57F287')
      .setDescription(`✅ Ticket claimed by ${interaction.user}`)
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
    
  } else if (interaction.customId === 'ticket_close_request') {
    const modal = new ModalBuilder()
      .setCustomId('ticket_close_reason_modal')
      .setTitle('Close Ticket Request');
    
    const reasonInput = new TextInputBuilder()
      .setCustomId('close_reason')
      .setLabel('Reason for closing')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Please provide a reason for closing this ticket...')
      .setRequired(true)
      .setMaxLength(1000);
    
    const row = new ActionRowBuilder().addComponents(reasonInput);
    modal.addComponents(row);
    
    await interaction.showModal(modal);
    
  } else if (interaction.customId === 'ticket_close') {
    // Check permissions
    const canClose = interaction.user.id === ticketData.claimedBy || 
                    interaction.user.id === ticketData.userId ||
                    interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    
    if (!canClose) {
      return interaction.reply({ content: '❌ Only the ticket claimer, ticket creator, or administrators can close this ticket!', ephemeral: true });
    }
    
    const modal = new ModalBuilder()
      .setCustomId('ticket_close_modal')
      .setTitle('Close Ticket');
    
    const reasonInput = new TextInputBuilder()
      .setCustomId('close_reason')
      .setLabel('Reason for closing')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Please provide a reason for closing this ticket...')
      .setRequired(true)
      .setMaxLength(1000);
    
    const row = new ActionRowBuilder().addComponents(reasonInput);
    modal.addComponents(row);
    
    await interaction.showModal(modal);
  }
});

// Modal submit handlers
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isModalSubmit()) return;
  
  const ticketData = activeTickets.get(interaction.channel.id);
  if (!ticketData) return;
  
  if (interaction.customId === 'ticket_close_modal') {
    await interaction.deferReply();
    
    const reason = interaction.fields.getTextInputValue('close_reason');
    
    // Generate transcript
    const messages = await interaction.channel.messages.fetch({ limit: 100 });
    const transcript = messages.reverse().map(m => 
      `[${m.createdAt.toLocaleString()}] ${m.author.tag}: ${m.content}`
    ).join('\n');
    
    // Send review modal to ticket creator
    const ticketCreator = await interaction.guild.members.fetch(ticketData.userId);
    
    try {
      // Create review embed
      const reviewEmbed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('📊 Ticket Review')
        .setDescription('Please rate your support experience!')
        .addFields([
          { name: 'Ticket Type', value: ticketData.type.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') },
          { name: 'Closed By', value: `${interaction.user}` },
          { name: 'Close Reason', value: reason }
        ]);
      
      const reviewRow = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`review_1_${interaction.channel.id}`)
            .setLabel('⭐')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`review_2_${interaction.channel.id}`)
            .setLabel('⭐⭐')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`review_3_${interaction.channel.id}`)
            .setLabel('⭐⭐⭐')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`review_4_${interaction.channel.id}`)
            .setLabel('⭐⭐⭐⭐')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`review_5_${interaction.channel.id}`)
            .setLabel('⭐⭐⭐⭐⭐')
            .setStyle(ButtonStyle.Primary)
        );
      
      // Send transcript to user
      const transcriptBuffer = Buffer.from(transcript, 'utf-8');
      await ticketCreator.send({ 
        content: '📄 Here is your ticket transcript:',
        files: [{ attachment: transcriptBuffer, name: `ticket-${interaction.channel.name}-transcript.txt` }],
        embeds: [reviewEmbed],
        components: [reviewRow]
      });
    } catch (err) {
      console.error('[TICKETS] Error sending review to user:', err);
    }
    
    // Log to ticket log channel
    if (LOG_CHANNELS.TICKET) {
      try {
        const logChannel = await interaction.client.channels.fetch(LOG_CHANNELS.TICKET);
        const logEmbed = new EmbedBuilder()
          .setColor('#ED4245')
          .setTitle('🔒 Ticket Closed')
          .addFields([
            { name: 'Ticket', value: `#${interaction.channel.name}`, inline: true },
            { name: 'Creator', value: `<@${ticketData.userId}>`, inline: true },
            { name: 'Closed By', value: `${interaction.user}`, inline: true },
            { name: 'Claimed By', value: ticketData.claimedBy ? `<@${ticketData.claimedBy}>` : '*Unclaimed*', inline: true },
            { name: 'Reason', value: reason }
          ])
          .setTimestamp();
        
        const transcriptBuffer = Buffer.from(transcript, 'utf-8');
        await logChannel.send({ 
          embeds: [logEmbed],
          files: [{ attachment: transcriptBuffer, name: `ticket-${interaction.channel.name}-transcript.txt` }]
        });
      } catch (err) {
        console.error('[TICKETS] Error logging ticket close:', err);
      }
    }
    
    await interaction.editReply({ content: '✅ Ticket will be closed in 5 seconds...' });
    
    ticketData.closed = true;
    saveTickets();
    
    setTimeout(async () => {
      try {
        await interaction.channel.delete();
        activeTickets.delete(interaction.channel.id);
        saveTickets();
      } catch (err) {
        console.error('[TICKETS] Error deleting ticket channel:', err);
      }
    }, 5000);
    
  } else if (interaction.customId === 'ticket_close_reason_modal') {
    const reason = interaction.fields.getTextInputValue('close_reason');
    
    const embed = new EmbedBuilder()
      .setColor('#FEE75C')
      .setDescription(`📝 ${interaction.user} requested to close this ticket\n**Reason:** ${reason}`)
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  }
});

// Review button handler
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('review_')) return;
  
  const [, rating, channelId] = interaction.customId.split('_');
  
  await interaction.deferUpdate();
  
  // Log review to ticket log channel
  if (LOG_CHANNELS.TICKET) {
    try {
      const logChannel = await interaction.client.channels.fetch(LOG_CHANNELS.TICKET);
      const stars = '⭐'.repeat(parseInt(rating));
      
      const reviewEmbed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('⭐ Ticket Review Received')
        .addFields([
          { name: 'Rating', value: stars, inline: true },
          { name: 'Reviewer', value: `${interaction.user}`, inline: true },
          { name: 'Ticket', value: `Channel ID: ${channelId}`, inline: true }
        ])
        .setTimestamp();
      
      await logChannel.send({ embeds: [reviewEmbed] });
      
      await interaction.editReply({ 
        content: `✅ Thank you for your feedback! You rated your experience: ${stars}`,
        components: []
      });
    } catch (err) {
      console.error('[TICKETS] Error logging review:', err);
    }
  }
});

// Error handling
client.on(Events.Error, (error) => {
  console.error('[MOD BOT ERROR]', error);
});

process.on('unhandledRejection', (error) => {
  console.error('[UNHANDLED REJECTION]', error);
});

// Login
client.login(DISCORD_TOKEN).catch(err => {
  console.error('[MOD BOT] Failed to login:', err);
});
