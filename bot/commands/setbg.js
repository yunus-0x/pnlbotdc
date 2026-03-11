'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const crypto  = require('crypto');

const { setBackground } = require('../storage');

const DATA_DIR = path.join(__dirname, '..', 'data');

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(destPath);
    proto.get(url, (res) => {
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

function buildCommand(name, description) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addAttachmentOption((opt) =>
      opt.setName('image')
        .setDescription('Background image or video (mp4/webm/mov/png/jpg/gif)')
        .setRequired(true)
    );
}

async function handleSetBg(interaction, type) {
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  if (adminRoleId && !interaction.member.roles.cache.has(adminRoleId)) {
    return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const attachment = interaction.options.getAttachment('image');
  if (!attachment) {
    return interaction.editReply('No attachment provided.');
  }

  const ext     = path.extname(attachment.name || '').toLowerCase() || '.png';
  const destName = `bg_${type}${ext}`;
  const destPath = path.join(DATA_DIR, destName);

  fs.mkdirSync(DATA_DIR, { recursive: true });

  try {
    await download(attachment.url, destPath);
    setBackground(type, destPath);
    await interaction.editReply(`Default ${type} background set to \`${attachment.name}\`.`);
  } catch (err) {
    await interaction.editReply(`Failed to save background: ${err.message}`);
  }
}

module.exports = {
  data: [
    buildCommand('setbgp', 'Set default profit background (admin only)'),
    buildCommand('setbgl', 'Set default loss background (admin only)'),
  ],

  async execute(interaction) {
    const type = interaction.commandName === 'setbgp' ? 'profit' : 'loss';
    await handleSetBg(interaction, type);
  },
};
