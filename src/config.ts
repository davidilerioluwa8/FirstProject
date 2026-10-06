export type WhatsAppMode = 'mock' | 'cloud';

export interface Config {
  port: number;
  databasePath: string;
  mode: WhatsAppMode;
  /** Business phone number, digits only, used to build wa.me join links. */
  businessPhone: string;
  admin: { user: string; password: string | null };
  whatsapp: {
    accessToken: string;
    phoneNumberId: string;
    appSecret: string;
    verifyToken: string;
    apiVersion: string;
  };
  sendRatePerSecond: number;
  schedulerIntervalMs: number;
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${value}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = (env.WHATSAPP_MODE ?? 'mock').toLowerCase();
  if (mode !== 'mock' && mode !== 'cloud') {
    throw new Error(`WHATSAPP_MODE must be "mock" or "cloud", got "${env.WHATSAPP_MODE}"`);
  }

  const config: Config = {
    port: int(env.PORT, 3000, 'PORT'),
    databasePath: env.DATABASE_PATH || './data/app.db',
    mode,
    businessPhone: (env.WHATSAPP_BUSINESS_PHONE ?? '').replace(/\D/g, ''),
    admin: {
      user: env.ADMIN_USER || 'admin',
      password: env.ADMIN_PASSWORD || null,
    },
    whatsapp: {
      accessToken: env.WHATSAPP_ACCESS_TOKEN ?? '',
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? '',
      appSecret: env.WHATSAPP_APP_SECRET ?? '',
      verifyToken: env.WHATSAPP_VERIFY_TOKEN ?? '',
      apiVersion: env.WHATSAPP_API_VERSION || 'v23.0',
    },
    sendRatePerSecond: int(env.SEND_RATE_PER_SECOND, 20, 'SEND_RATE_PER_SECOND'),
    schedulerIntervalMs: int(env.SCHEDULER_INTERVAL_MS, 15000, 'SCHEDULER_INTERVAL_MS'),
  };

  if (config.mode === 'cloud') {
    const missing = [
      ['WHATSAPP_ACCESS_TOKEN', config.whatsapp.accessToken],
      ['WHATSAPP_PHONE_NUMBER_ID', config.whatsapp.phoneNumberId],
      ['WHATSAPP_APP_SECRET', config.whatsapp.appSecret],
      ['WHATSAPP_VERIFY_TOKEN', config.whatsapp.verifyToken],
      ['WHATSAPP_BUSINESS_PHONE', config.businessPhone],
      ['ADMIN_PASSWORD', config.admin.password],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(`WHATSAPP_MODE=cloud requires: ${missing.join(', ')}`);
    }
  }

  return config;
}
