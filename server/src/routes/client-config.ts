import type { FastifyInstance } from 'fastify';

/**
 * What the app checks on launch and on every foreground: the oldest app
 * version this server still serves, the newest one in the store, and where to
 * get it. Raising the floor at cutover is a `fly secrets set MIN_APP_VERSION=…`,
 * not a deploy, and an app below it shows a full-screen "Update Editify" gate.
 *
 * `minOs` is the iOS floor of the version the gate sends people to. A phone
 * below it cannot install that version, so the app shows the sunset screen
 * (export your videos to Photos) instead of a store button that leads nowhere.
 */
export interface ClientConfig {
  minVersion: string;
  latestVersion: string;
  storeUrl: string;
  /** Always sent, so no client has to guess the floor. */
  minOs: string;
  /**
   * Sent (true) only while this server is a pre-cutover test server (TEST_SERVER=1, editify-v11
   * before launch): TestFlight builds then show the "separate test server" banner (C8, C18).
   * Absent everywhere else, so a 1.1 build on the launched server never shows it.
   */
  testServer?: true;
}

export const DEFAULT_MIN_VERSION = '1.0.0';
export const DEFAULT_STORE_URL = 'https://apps.apple.com/app/id6814607865';
/** Editify 1.1's iOS floor. MIN_IOS_VERSION overrides it. */
export const DEFAULT_MIN_OS = '18.0';

const VERSION = /^\d+(\.\d+){0,2}$/;

/** A malformed secret falls back to the default rather than shipping a value no client can compare. */
function version(value: string | undefined, fallback: string, name: string, warn: (message: string) => void): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  if (VERSION.test(trimmed)) return trimmed;
  warn(`${name}=${JSON.stringify(trimmed)} is not a version like 1.1.0; using ${fallback}`);
  return fallback;
}

/**
 * The client drops the whole config when `storeUrl` is not http(s), which
 * would quietly un-gate every phone, so a bad secret falls back here instead.
 */
function storeUrl(value: string | undefined, warn: (message: string) => void): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_STORE_URL;
  if (/^https?:\/\/\S+$/i.test(trimmed)) return trimmed;
  warn(`APP_STORE_URL=${JSON.stringify(trimmed)} is not an http(s) URL; using ${DEFAULT_STORE_URL}`);
  return DEFAULT_STORE_URL;
}

export function readClientConfig(env: NodeJS.ProcessEnv = process.env, warn: (message: string) => void = console.warn): ClientConfig {
  const minVersion = version(env.MIN_APP_VERSION, DEFAULT_MIN_VERSION, 'MIN_APP_VERSION', warn);
  const latestVersion = version(env.LATEST_APP_VERSION, minVersion, 'LATEST_APP_VERSION', warn);
  return {
    minVersion,
    latestVersion,
    storeUrl: storeUrl(env.APP_STORE_URL, warn),
    minOs: version(env.MIN_IOS_VERSION, DEFAULT_MIN_OS, 'MIN_IOS_VERSION', warn),
    ...(env.TEST_SERVER?.trim() === '1' ? { testServer: true as const } : {}),
  };
}

/** Unauthenticated (see `isPublic` in app.ts): a signed-out phone has to be gated too. */
export function registerClientConfigRoutes(app: FastifyInstance, env: NodeJS.ProcessEnv = process.env): void {
  app.get('/client-config', async (request, reply) => {
    const config = readClientConfig(env, (message) => request.log.warn(message));
    // Briefly cacheable: a raised floor reaches every phone within a minute.
    return await reply.header('Cache-Control', 'public, max-age=60').send(config);
  });
}

export function isClientConfigRoute(url: string | undefined): boolean {
  return url === '/client-config';
}
