// Owner profile loader.
//
// Priority:
// 1. Render Secret File (/etc/secrets/ownerProfile.private.json)
// 2. Local private profile JSON (ownerProfile.private.json)
// 3. Public example profile JSON (ownerProfile.example.json)
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type PreferredLength = 'short' | 'medium' | 'long';

export interface OwnerProfileShape {
  username: string;
  identity: string;
  domains: string[];
  domainKeywords: string[];
  moods: string[];
  tones: string[];
  language: string[];
  experienceVoice: string;
  cities: string[];
  hobbies: string[];
  slangs: string[];
  avoid: string[];
  voiceSeed: string;
  preferredLength: PreferredLength;
  tweetLanguages: string[];
  coldStartTopics: string[];
}

const ROOT_DIR = process.cwd();
const LOCAL_PRIVATE_PROFILE = join(ROOT_DIR, 'ownerProfile.private.json');
const LOCAL_EXAMPLE_PROFILE = join(ROOT_DIR, 'ownerProfile.example.json');
const RENDER_PRIVATE_PROFILE = '/etc/secrets/ownerProfile.private.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: keyof OwnerProfileShape, source: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid owner profile in ${source}: ${field} must be a non-empty string`);
  }

  return value;
}

function requireStringArray(value: unknown, field: keyof OwnerProfileShape, source: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`Invalid owner profile in ${source}: ${field} must be a non-empty string array`);
  }

  return value;
}

function requirePreferredLength(value: unknown, source: string): PreferredLength {
  if (value !== 'short' && value !== 'medium' && value !== 'long') {
    throw new Error(`Invalid owner profile in ${source}: preferredLength must be short, medium, or long`);
  }

  return value;
}

function validateOwnerProfile(value: unknown, source: string): OwnerProfileShape {
  if (!isRecord(value)) {
    throw new Error(`Invalid owner profile in ${source}: expected a JSON object`);
  }

  return {
    username: requireString(value.username, 'username', source),
    identity: requireString(value.identity, 'identity', source),
    domains: requireStringArray(value.domains, 'domains', source),
    domainKeywords: requireStringArray(value.domainKeywords, 'domainKeywords', source),
    moods: requireStringArray(value.moods, 'moods', source),
    tones: requireStringArray(value.tones, 'tones', source),
    language: requireStringArray(value.language, 'language', source),
    experienceVoice: requireString(value.experienceVoice, 'experienceVoice', source),
    cities: requireStringArray(value.cities, 'cities', source),
    hobbies: requireStringArray(value.hobbies, 'hobbies', source),
    slangs: requireStringArray(value.slangs, 'slangs', source),
    avoid: requireStringArray(value.avoid, 'avoid', source),
    voiceSeed: requireString(value.voiceSeed, 'voiceSeed', source),
    preferredLength: requirePreferredLength(value.preferredLength, source),
    tweetLanguages: requireStringArray(value.tweetLanguages, 'tweetLanguages', source),
    coldStartTopics: requireStringArray(value.coldStartTopics, 'coldStartTopics', source),
  };
}

function parseOwnerProfileJson(raw: string, source: string): OwnerProfileShape {
  try {
    return validateOwnerProfile(JSON.parse(raw), source);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid owner profile in ${source}: JSON parse failed - ${error.message}`);
    }

    throw error;
  }
}

function loadProfileFile(path: string): OwnerProfileShape {
  return parseOwnerProfileJson(readFileSync(path, 'utf8'), path);
}

function firstExistingPath(paths: string[]): string | null {
  return paths.find(path => path && existsSync(path)) ?? null;
}

function loadOwnerProfile(): OwnerProfileShape {
  const privateProfilePath = firstExistingPath([
    RENDER_PRIVATE_PROFILE,
    LOCAL_PRIVATE_PROFILE,
  ]);

  if (privateProfilePath) {
    return loadProfileFile(privateProfilePath);
  }

  if (existsSync(LOCAL_EXAMPLE_PROFILE)) {
    return loadProfileFile(LOCAL_EXAMPLE_PROFILE);
  }

  throw new Error(
    `Missing owner profile. Create ownerProfile.private.json from ownerProfile.example.json, or upload ownerProfile.private.json as a Render Secret File at ${RENDER_PRIVATE_PROFILE}.`,
  );
}

export const OWNER_PROFILE: OwnerProfileShape = loadOwnerProfile();
