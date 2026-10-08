# Version Split

This project is maintained in two practical tracks:

## 1. Open-Source Track

The public repository should contain only the open-source workflow:

- Local project folder setup
- User-configured model settings
- HTML/PPT generation
- Local image binding only
- No AI image generation
- No stock-image retrieval

## 2. Internal Track

Image-generation and stock-retrieval experiments are kept locally for future product work, but they are **not part of the public repository**.

Local-only internal references should live under:

```text
.internal/
```

That directory is git-ignored on purpose.

## Rule of Thumb

If a feature requires:

- AI image generation
- stock-photo retrieval
- private prompts for image orchestration

it belongs to the internal track, not the public open-source workflow.
