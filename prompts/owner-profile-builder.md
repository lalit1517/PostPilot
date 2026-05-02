# Owner Profile Builder Prompt

Use this prompt with the LLM you talk to regularly, such as ChatGPT, Claude, or Gemini, to create or enrich `ownerProfile.private.json`.

Recommended default: use **patch mode** first. It is safer because it only updates topic and interest fields instead of rewriting the full persona.

Before pasting anything:

- Do not include API keys, tokens, passwords, private client names, private employer details, or addresses.
- Review every generated item before using it.
- Delete anything that feels inflated, too personal, inaccurate, or performative.

## Prompt

```text
You are helping me build a conservative, realistic PostPilot owner profile.

PostPilot uses this profile to generate X/Twitter draft topics and voice. Your job is to help me fill the JSON carefully from what you know about me from our conversations and from any extra notes I provide below.

Important behavior rules:

1. Do not exaggerate me.
2. Do not make me sound more senior, famous, successful, rich, productive, philosophical, or visionary than the evidence supports.
3. Do not invent achievements, employers, clients, revenue, credentials, awards, followers, or authority.
4. Do not turn me into a motivational founder, guru, influencer, or thought leader.
5. Prefer grounded, everyday, slightly specific topics over grand claims.
6. If you are unsure whether I care about something, omit it instead of guessing.
7. Do not include secrets, API keys, tokens, passwords, private company/client details, exact addresses, or sensitive personal data.
8. Keep the profile useful for tweet topic selection, not for autobiography.
9. Make topics sound like things I would actually post about on a normal day.
10. Return valid JSON only. No markdown, no comments, no explanation.

My intended content mix:

- Mostly tech/AI/dev/product-engineering content.
- Some personal/culture content only when it matches my actual interests.
- Culture examples can include music, artists, songs, products, tech CEOs, companies, startups, hobbies, cities, and everyday routines.

Use this schema:

{
  "username": "string",
  "identity": "string",
  "domains": ["string"],
  "domainKeywords": ["string"],
  "moods": ["string"],
  "tones": ["string"],
  "language": ["string"],
  "experienceVoice": "string",
  "cities": ["string"],
  "hobbies": ["string"],
  "slangs": ["string"],
  "avoid": ["string"],
  "voiceSeed": "string",
  "preferredLength": "short | medium | long",
  "tweetLanguages": ["en"],
  "topicMix": {
    "tech": 80,
    "culture": 20
  },
  "evergreenTechTopics": ["string"],
  "personalTopics": ["string"],
  "cultureTopics": ["string"],
  "cultureInterests": {
    "artists": ["string"],
    "companies": ["string"],
    "people": ["string"],
    "products": ["string"],
    "startups": ["string"],
    "songs": ["string"],
    "hobbies": ["string"]
  },
  "coldStartTopics": ["string"]
}

Output mode:

Choose exactly one mode based on my instruction below.

FULL_PROFILE mode:
- Output the complete JSON object matching the schema above.
- Keep it realistic and not overstuffed.
- `evergreenTechTopics` should contain 20-50 concrete topic seeds.
- `personalTopics` should contain 10-25 concrete topic seeds.
- `cultureTopics` should contain 10-25 concrete topic seeds.
- `coldStartTopics` should mirror or closely match `evergreenTechTopics` for legacy compatibility.

PATCH mode:
- Output only this JSON object shape:
{
  "domains": [],
  "domainKeywords": [],
  "moods": [],
  "tones": [],
  "language": [],
  "experienceVoice": "",
  "cities": [],
  "hobbies": [],
  "slangs": [],
  "avoid": [],
  "voiceSeed": "",
  "evergreenTechTopics": [],
  "personalTopics": [],
  "cultureTopics": [],
  "cultureInterests": {
    "artists": [],
    "companies": [],
    "people": [],
    "products": [],
    "startups": [],
    "songs": [],
    "hobbies": []
  }
}
- Include only fields where you have useful additions.
- Use empty arrays or empty strings for fields that should not change.
- Do not include duplicate values from my existing profile if I paste it.

Quality checklist before final output:

- Remove anything that sounds like resume padding.
- Remove anything that sounds like generic AI-founder branding.
- Remove generic topics like "the future of AI" unless turned into a concrete personal/dev angle.
- Make sure every topic can plausibly become a short tweet under 280 characters.
- Make sure `domainKeywords` are lowercase search/filter terms, not long sentence topics.
- Make sure `evergreenTechTopics`, `personalTopics`, and `cultureTopics` are tweetable topic seeds, not just keywords.
- Make sure `cultureInterests` contains names/entities/interests, not full tweet ideas.
- Keep `avoid` strict and practical.

My requested mode:
[PATCH or FULL_PROFILE]

My current profile JSON, if any:
[paste ownerProfile.private.json or leave blank]

Extra facts I explicitly want considered:
[write notes about my work, interests, favorite products, favorite artists/songs, cities, hobbies, style, and topics to avoid]
```

## How To Apply Patch Output

If you choose patch mode, merge the non-empty fields into `ownerProfile.private.json` manually:

- Append new array values after removing duplicates.
- Replace string fields only when the new version is more accurate.
- Keep `coldStartTopics` aligned with `evergreenTechTopics` if you still use legacy compatibility.
- Validate the JSON before deploying it to Render.
