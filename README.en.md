# Prompt Panel

A SillyTavern extension that lets you read, translate, search, and export your presets, world info, and character cards from a single panel.

## Features

### Loading data
The panel loads **presets, world info books, and character cards that are registered in your current SillyTavern instance** and shows them in-place.

### Translation
- Per-toggle / per-entry / per-field translation with selective re-translation
- Translation cache is stored in the browser's IndexedDB (not in the SillyTavern settings file)
- Supported providers: OpenAI, Claude, Google AI Studio (MakerSuite), Vertex AI, OpenRouter, DeepSeek, Mistral, Groq, Cohere, xAI
- Per-provider sampling parameters can be configured individually

### Search
Keyword search runs against both the original and translated text. Matching parts are highlighted inline in the panel.

### Token count
The total token count of all loaded items, and the sum for the selected toggles, are shown live.

### Copy & Export
Each tab (Preset / World Info / Character) has three icon buttons in the top-right area.

- **Copy** — copy to clipboard
- **TXT export** — save as a text file
- **JSON export** — save as a SillyTavern-compatible JSON file

#### Copy / TXT export
You can select only some toggles and copy/export just those. When you trigger the action you choose between **Original / Translated / Both**. Untranslated items show up as `(번역없음)` in the "Translated" and "Both" modes.

#### JSON export
- **Preset** is **always exported in full**, regardless of selection (so the structure stays valid). **Embedded regex scripts and other extension settings are exported alongside the prompts**
- **World Info** exports only the selected entries when partial selection is used.
- **Character Card** applies translations only to the selected fields when partial selection is used. **If the card contains an embedded `character_book`**, you'll be asked whether to include it; if you choose to include it, it is exported as-is (original content).
- Toggle titles are translated too. On JSON export, the translated title is placed back into the proper name field (`name` for preset prompts, `comment` for world info entries).

#### File name
Files are auto-named as `{sourceName}_{targetLanguage}.{extension}` and saved to the browser's default download folder.

### UI
- **Floating icon**: optional, draggable on-screen icon that opens the panel from anywhere
- Preset / World Info / Character tabs
- Refresh button in the panel header — instantly syncs newly added/removed items from SillyTavern (translation cache is preserved)
- Adjustable font size for both original and translated text
- Six themes: Dark, Light, Pink, Mint, Orange, Blue

### Target Languages
Korean, English, Japanese, Chinese (Simplified), Chinese (Traditional), Polish.

## Installation

Choose one of the following:

1. Install via SillyTavern's extension manager using the GitHub URL  
2. Download the zip from this repository and extract it into `data/default-user/extensions/` inside your SillyTavern folder.

## Notes

- All exports work on a deep clone of the source data and modify only the clone, so **your original presets, world info, and character cards are never modified.**
- The character card JSON export uses the V3 spec's `data.*` path as the source of truth and clears the V1-compat top-level duplicates to keep the file lean. SillyTavern reads `data.*` first on import, so compatibility is unaffected.

## Credits

The API connection logic (provider handling, sampling parameters) was adapted from the following extensions:

- [llm-translator](https://github.com/1234anon/llm-translator) by 1234anon
- [llm-translator-custom](https://github.com/NamelessKkang/llm-translator-custom) — a fork of the above

Both are licensed under AGPL-3.0.

## License

AGPL-3.0. See [LICENSE](LICENSE) for the full text.
