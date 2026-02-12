# Character Conversation Pack Schema

## Overview

A **Conversation Pack** is a JSONL file containing prewritten character snippets
used for real-time retrieval-augmented reply composition. Each line is a JSON object
representing one pack item.

## Fields

| Field    | Type       | Required | Description |
|----------|------------|----------|-------------|
| `id`     | `string`   | yes | Stable unique identifier, e.g. `iris-quip-001` |
| `kind`   | `enum`     | yes | One of: `quip`, `template`, `explanation`, `dialogue`, `boundary` |
| `intent` | `string[]` | yes | Which user intents this item suits: `question`, `debug`, `brainstorm`, `vent`, `decide`, `smalltalk` |
| `tone`   | `string[]` | yes | Voice tones: `noir-dry`, `warm`, `blunt`, `calm` |
| `length` | `enum`     | yes | Length budget: `1line`, `short`, `medium` |
| `domain` | `string[]` | yes | Topic tags, e.g. `opsec`, `corpsec`, `privacy`, `solidarity`, `general`, `tech` |
| `usage`  | `enum`     | yes | How the text may be used: `verbatim_ok`, `paraphrase`, `structure_only` |
| `text`   | `string`   | yes | The actual content |

## Kind Descriptions

- **quip**: One-line acknowledgments, greetings, deflections, flavor. ~5-20 words.
- **template**: Short response patterns (1-3 lines) that can be lightly personalized.
- **explanation**: Canonical explanations of core topics (80-200 words) in character voice.
- **dialogue**: Multi-turn conversation exemplars (6-12 turns) showing interaction patterns.
- **boundary**: Safety/refusal responses in character voice. Used when state gate flags sensitive content.

## Tagging Guidance

- **intent**: Tag with ALL intents where the item could be useful. Most quips work for `smalltalk`.
- **tone**: Tag the natural tone of the text. Most items should include `noir-dry` for Iris.
- **domain**: Use specific tags. `general` is a fallback for items that aren't domain-specific.
- **usage**:
  - `verbatim_ok` — can be used as-is with only noun substitution
  - `paraphrase` — rewrite freely but preserve voice markers
  - `structure_only` — use the dialogue flow/structure, not the exact words

## Character Slang (Iris Kade)

These terms get lexical boost during retrieval:
- `black ICE`, `ICE`, `corpsec`, `mesh`, `sprawl`, `runner`, `deck`
- `opsec`, `ghost`, `phantom`, `wetware`, `chrome`, `jack in`
- `flatline`, `bricked`, `zero-day`, `exploit`, `payload`
- `shadownet`, `darkpool`, `dead drop`, `burn notice`
