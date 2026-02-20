/**
 * Configuration types.
 */

export interface SoundConfig {
  completed: string;
  waiting: string;
}

export interface RelayAuth {
  enabled: boolean;
  token: string | null;
}

export interface RelayConfig {
  enabled: boolean;
  port: number;
  auth: RelayAuth;
}

export interface ChannelRef {
  enabled: boolean;
  priority?: number;
}

export interface AppConfig {
  language: string;
  sound: SoundConfig;
  enabled: boolean;
  timeout: number;
  customMessages: {
    completed: string | null;
    waiting: string | null;
  };
  channels: {
    desktop: ChannelRef;
    [key: string]: ChannelRef;
  };
  relay: RelayConfig;
  [key: string]: unknown;
}

export interface ChannelConfig {
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface ChannelsConfig {
  [channelName: string]: ChannelConfig;
}

export interface Notification {
  type: string;
  title: string;
  message: string;
  project: string;
  metadata: {
    timestamp: string;
    language: string;
    [key: string]: unknown;
  };
}
