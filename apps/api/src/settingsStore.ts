import { reportSilentFailure } from '@praetor/core';
import * as path from 'node:path';
import { atomicWriteFileSync, readJsonFileSafe, isPlainObjectJson } from './atomicWrite';

/**
 * Global application settings store.
 *
 * Keeps a single JSON file at `.commander/settings.json` for runtime-tunable
 * configuration (model, feature flags, notifications). Falls back to the
 * legacy `.commander.json` used by the CLI so the Web UI and CLI share the
 * same model override when no explicit settings file exists.
 */

export interface NotificationSettings {
  emailEnabled?: boolean;
  email?: string;
  webhookUrl?: string;
  slackWebhook?: string;
  alertsEnabled?: boolean;
}

export interface AppSettings {
  model?: string;
  enableMetaTools?: boolean;
  toolRetrieval?: boolean;
  entropyGating?: boolean;
  speculativeExecution?: boolean;
  notifications?: NotificationSettings;
}

const SETTINGS_DIR = path.resolve(process.cwd(), '.commander');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');
const LEGACY_CONFIG_FILE = path.resolve(process.cwd(), '.commander.json');

function readJsonFile<T>(filePath: string): T | undefined {
  // REL-4: 损坏或错形（非对象）隔离，禁止 silent discard → save 抹掉 settings。
  return readJsonFileSafe<T | undefined>(filePath, undefined, isPlainObjectJson);
}

function writeJsonFile(filePath: string, data: unknown): void {
  // REL-3: fsync-then-rename via shared atomicWrite helper.
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadLegacySettings(): Partial<AppSettings> {
  const legacy = readJsonFile<Record<string, unknown>>(LEGACY_CONFIG_FILE);
  if (!legacy) return {};

  const settings: Partial<AppSettings> = {};
  if (typeof legacy.model === 'string') settings.model = legacy.model;
  if (typeof legacy.enableMetaTools === 'boolean')
    settings.enableMetaTools = legacy.enableMetaTools;
  if (typeof legacy.toolRetrieval === 'boolean') settings.toolRetrieval = legacy.toolRetrieval;
  if (typeof legacy.entropyGating === 'boolean') settings.entropyGating = legacy.entropyGating;
  if (typeof legacy.speculativeExecution === 'boolean') {
    settings.speculativeExecution = legacy.speculativeExecution;
  }
  return settings;
}

export function loadSettings(): AppSettings {
  const stored = readJsonFile<AppSettings>(SETTINGS_FILE);
  if (stored) return stored;

  const legacy = loadLegacySettings();
  return legacy;
}

export function saveSettings(settings: AppSettings): void {
  try {
    writeJsonFile(SETTINGS_FILE, settings);
  } catch (err) {
    reportSilentFailure(err, 'settingsStore:saveSettings');
    throw new Error('Failed to save settings');
  }
}

export function updateSettings(partial: Partial<AppSettings>): AppSettings {
  const current = loadSettings();
  const merged: AppSettings = { ...current, ...partial };

  // Merge nested notifications rather than replacing the whole object.
  if (partial.notifications !== undefined && current.notifications !== undefined) {
    merged.notifications = { ...current.notifications, ...partial.notifications };
  }

  saveSettings(merged);
  return merged;
}
