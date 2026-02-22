/**
 * Encrypted State Backup
 *
 * Periodically backs up all channel states.
 * AES-256-GCM encryption. Local + optional IPFS.
 */

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

class BackupService {
  constructor(encryptionKey, backupDir = './backups') {
    // Derive 256-bit key from passphrase
    this.key = crypto.scryptSync(encryptionKey || 'default-change-me', 'agent-casino-salt', 32);
    this.backupDir = backupDir;
  }

  async init() {
    await fs.mkdir(this.backupDir, { recursive: true });
  }

  /**
   * Backup all channel states (encrypted).
   */
  async backupChannels(channels) {
    const data = {};
    for (const [addr, channel] of channels) {
      data[addr] = {
        agentBalance: channel.agentBalance,
        casinoBalance: channel.casinoBalance,
        nonce: channel.nonce,
        gamesPlayed: channel.games.length,
        createdAt: channel.createdAt,
      };
    }

    const plaintext = JSON.stringify({
      timestamp: Date.now(),
      channelCount: channels.size,
      channels: data,
    });

    const encrypted = this._encrypt(plaintext);
    const filename = `backup-${Date.now()}.enc`;
    const filepath = path.join(this.backupDir, filename);

    await fs.writeFile(filepath, encrypted);

    // Keep only last 100 backups
    await this._pruneBackups(100);

    return { filepath, size: encrypted.length, channels: channels.size };
  }

  /**
   * Restore channels from backup.
   */
  async restoreLatest() {
    const files = await fs.readdir(this.backupDir);
    const backups = files
      .filter(f => f.startsWith('backup-') && f.endsWith('.enc'))
      .sort()
      .reverse();

    if (backups.length === 0) return null;

    const filepath = path.join(this.backupDir, backups[0]);
    const encrypted = await fs.readFile(filepath);
    const plaintext = this._decrypt(encrypted);

    return JSON.parse(plaintext);
  }

  _encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]);
  }

  _decrypt(buffer) {
    const iv = buffer.subarray(0, 12);
    const tag = buffer.subarray(12, 28);
    const encrypted = buffer.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  }

  async _pruneBackups(keep) {
    const files = await fs.readdir(this.backupDir);
    const backups = files
      .filter(f => f.startsWith('backup-') && f.endsWith('.enc'))
      .sort();

    if (backups.length > keep) {
      const toDelete = backups.slice(0, backups.length - keep);
      for (const f of toDelete) {
        await fs.unlink(path.join(this.backupDir, f));
      }
    }
  }
}

module.exports = BackupService;
