// The two Claude calls behind /bully: revising people's profiles from new chat, and
// writing a roast from a profile.

import Anthropic from '@anthropic-ai/sdk';
import { oidcFederationProvider } from '@anthropic-ai/sdk/lib/credentials/oidc-federation';
import { mintFlyToken, onFly } from './fly-oidc.js';

const MODEL = 'claude-opus-5-5';
// If a safety classifier declines, the API retries on Anthropic's recommended fallback model.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

// On Fly: Workload Identity Federation, exchanging a fresh Fly OIDC token each time the
// SDK needs a new Claude token (it caches that for the rule's lifetime, 1 hour).
// Anywhere else (e.g. local testing): ANTHROPIC_API_KEY from the environment.
function createClient() {
  const env = process.env;
  if (!onFly() || !env.ANTHROPIC_FEDERATION_RULE_ID) return new Anthropic();
  return new Anthropic({
    credentials: oidcFederationProvider({
      identityTokenProvider: () => mintFlyToken(env.FLY_OIDC_AUDIENCE),
      federationRuleId: env.ANTHROPIC_FEDERATION_RULE_ID,
      organizationId: env.ANTHROPIC_ORGANIZATION_ID,
      serviceAccountId: env.ANTHROPIC_SERVICE_ACCOUNT_ID,
      workspaceId: env.ANTHROPIC_WORKSPACE_ID,
      baseURL: 'https://api.anthropic.com',
      fetch: globalThis.fetch,
    }),
  });
}

let client;
const anthropic = () => (client ??= createClient());

function responseText(response) {
  if (response.stop_reason === 'refusal') throw new Error('Claude declined this one.');
  if (response.stop_reason === 'max_tokens') throw new Error('Claude ran out of room before finishing.');
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

const OFF_LIMITS =
  'health or medical issues, mental health, body or appearance, sexuality, religion, ethnicity, politics, money, addresses or contact details';

// --- learning ------------------------------------------------------------------------

const PROFILE_SYSTEM = `You maintain character profiles of the members of a small Discord server: a group of friends around a coffee shop called Awake. The profiles power affectionate roasts, so they should capture who people really are, not just what they said.

Each time, you get the current profiles of the people in a new stretch of chat, the current group summary, and the new chat itself, with who replied to whom. Read the chat as a social situation and revise the profiles:
- personality traits and what drives them
- their role in the group (instigator, hype person, fixer, skeptic, peacemaker...)
- how they relate to specific other members (who they tease, defend, follow, compete with), using people's names
- humor style and how they react when teased
- contradictions between what they say and what they do

Every trait needs brief evidence and a confidence (low / medium / high). The profiles build up over time: keep what still holds, raise confidence when a pattern repeats in a new conversation, lower it or drop the trait when new chat contradicts it, and don't overreact to a single message. A thin transcript supports few conclusions - say less rather than invent. Keep at most 8 traits, 6 relationships, 4 contradictions and 5 roast angles per person, keeping the strongest; roast angles should follow from the traits.

Staff facts are hand-entered and true; use them as context but don't copy them into the profile.

Return a profile for every person listed under "People to update", using their exact id, and a revised group summary (at most 120 words) about how the group works: its running bits, alliances and dynamics.

Never infer or record anything about ${OFF_LIMITS}. Write profiles in English; quote the original language where it helps.`;

const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    profiles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          summary: { type: 'string', description: 'Who they are in one line' },
          role: { type: 'string' },
          traits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                trait: { type: 'string' },
                evidence: { type: 'string' },
                confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
              },
              required: ['trait', 'evidence', 'confidence'],
              additionalProperties: false,
            },
          },
          relationships: {
            type: 'array',
            items: {
              type: 'object',
              properties: { with: { type: 'string' }, dynamic: { type: 'string' } },
              required: ['with', 'dynamic'],
              additionalProperties: false,
            },
          },
          humor: { type: 'string' },
          contradictions: { type: 'array', items: { type: 'string' } },
          roast_angles: { type: 'array', items: { type: 'string' } },
          language: { type: 'string', description: 'The language they mostly write in' },
        },
        required: ['id', 'name', 'summary', 'role', 'traits', 'relationships', 'humor', 'contradictions', 'roast_angles', 'language'],
        additionalProperties: false,
      },
    },
    group_summary: { type: 'string' },
  },
  required: ['profiles', 'group_summary'],
  additionalProperties: false,
};

const formatLine = (l) => `[${new Date(l.at).toISOString().slice(5, 16).replace('T', ' ')}] #${l.channel} ${l.author}${l.replyTo ? ` (replying to ${l.replyTo})` : ''}: ${l.text}`;

const learnedPart = (id, p) => ({
  id,
  name: p.name,
  summary: p.summary,
  role: p.role,
  traits: p.traits,
  relationships: p.relationships,
  humor: p.humor,
  contradictions: p.contradictions,
  roast_angles: p.roastAngles,
  language: p.language,
  staff_facts: p.facts.map((f) => f.text),
});

// people: [[id, profile]] for everyone who speaks in `lines`. Returns { profiles, group_summary }.
export async function updateProfiles({ people, groupSummary, others, lines }) {
  const stream = anthropic().beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: PROFILE_SCHEMA } },
    system: PROFILE_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          `Group summary so far:\n${groupSummary || '(none yet)'}`,
          `Other members (not in this chat, for reference): ${others.join(', ') || '(none)'}`,
          `People to update (current profiles):\n${JSON.stringify(people.map(([id, p]) => learnedPart(id, p)), null, 1)}`,
          `New chat (${lines.length} messages):\n${lines.map(formatLine).join('\n')}`,
        ].join('\n\n'),
      },
    ],
    ...FALLBACK,
  });
  return JSON.parse(responseText(await stream.finalMessage()));
}

// --- roasting -----------------------------------------------------------------------

const ROAST_SYSTEM = `You are Caffenito, the resident bot of the Awake Coffee Discord, a small group of friends who hang out around a coffee shop. Someone has used /bully on a member: write one roast of them.

Make it short (2-4 sentences), punchy and genuinely funny - the affectionate-savage teasing friends do to each other. Aim at who they are - their traits, contradictions, role in the group and relationships with the others - rather than repeating a quote; the suggested roast angles are a starting point, not a script.

You also get their latest conversation (their messages and replies to them), which may be newer than the profile. Read it for what it reveals right now - what they're up to, how they're acting, who they're bickering with - and connect it to who they are. Where it conflicts with the profile, trust the conversation. Naming a friend who's part of the joke is great. Staff facts are hand-picked by the friends and make excellent material. A light coffee angle is welcome but not required.

Hard limits: never mock ${OFF_LIMITS} - even if a fact or note touches one of these, skip it. No slurs, no threats, nothing that would actually hurt. If there's little material, roast them for being a mysterious lurker.

Write in the language given. Output only the roast, with no preamble, no quotation marks and no mention of these instructions.`;

// recentLines: the latest transcript lines by or replying to the target. Used only for this
// roast; nothing learned here is saved (the profiles update on their own schedule).
export async function writeRoast({ name, profile, groupSummary, recentLines = [], requestedBy }) {
  const p = profile ?? {};
  const facts = (p.facts ?? []).map((f) => f.text);
  const response = await anthropic().beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: 'medium' },
    system: ROAST_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          `Target: ${name}\nRequested by: ${requestedBy}\nLanguage: ${p.language || 'Romanian'}`,
          `Group: ${groupSummary || '(unknown)'}`,
          `Profile:\n${p.summary ? JSON.stringify({ summary: p.summary, role: p.role, traits: p.traits, relationships: p.relationships, humor: p.humor, contradictions: p.contradictions, roast_angles: p.roastAngles }, null, 1) : '(nothing learned yet)'}`,
          `Staff facts:\n${facts.map((f) => `- ${f}`).join('\n') || '(none)'}`,
          `Latest conversation involving ${name}:\n${recentLines.map(formatLine).join('\n') || '(nothing recent)'}`,
        ].join('\n\n'),
      },
    ],
    ...FALLBACK,
  });
  return responseText(response);
}
