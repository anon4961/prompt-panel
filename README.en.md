# Prompt Panel

A SillyTavern extension that lets you read, translate, search, and export your presets, world info, and character cards from a single panel.

## Features

### Loading data
The panel loads **presets, world info books, and character cards that are registered in your current SillyTavern instance** and shows them in-place.

Tap the name field to open the list. Pick one, then press `📂 로드` to load the preset.
- **Search**: type a name in the search box at the top. Korean initial consonants, part of a title, and translated names all work
- **Recent**: the last 5 items loaded with `📂 로드` are listed separately
- **Name translation 📛**: translates the names in the list (presets, world info, characters). Pressing it adds check boxes to the list; tick the names to translate, then translate. Names are sent in batches of the `제목 번역 묶음 개수` (title batch size) setting. Names that already have a translation are skipped; if only translated ones are ticked, you can choose to translate them again. With Korean as the target, names that are already Korean are not sent.
- **👀**: switch between translated and original names. Turns on by itself after translating, and the original name is shown small under the translation.
- Translated names appear **only inside the panel**. The real preset, world info and character names are never changed. Name translations are included in the cache backup.
- When two character cards share a name, their file names are shown

### Translation
- Per-toggle / per-entry / per-field translation with selective re-translation
- Translation cache is stored in the browser's IndexedDB (not in the SillyTavern settings file)
- **Cache backup & restore**: the cache section of the extension settings can export the whole translation cache to a file and import it back.
- Supported providers: OpenAI, Claude, Google AI Studio (MakerSuite), Vertex AI, OpenRouter, DeepSeek, Z.AI (GLM), and **Custom (OpenAI-compatible)**
  - **Custom**: enter an OpenAI-compatible address (usually ending in `/v1`) and an API key to connect any other service (Mistral, Groq, xAI, relay APIs, local servers...). The `모델 목록 불러오기` button checks the connection and lets you pick a model. A key you type is stored only in the browser (IndexedDB), never in the SillyTavern settings file or in backups. With the key box empty, a key SillyTavern already holds for the **same address** is found automatically (the key of a Custom connection profile, the password of a reverse-proxy preset, or the current key of SillyTavern's own Custom connection when it points at that address). The key box and the result of `모델 목록 불러오기` say which key is used. No prefill is sent.
  - Following each vendor's guidance, some values are not sent to the newest models even when set. Sampling values (temperature etc.): GPT-5.5 and later / GPT-6, Claude Opus 4.7 and later / Claude 5 / Fable, Gemini 3.5 and later. Prefill: Gemini 3.5 and later, Claude 4.6 and later.
- **Preset glossary**: the meaning of slang used in SillyTavern-related communities is defined separately. Editable and extendable. Stored separately in the browser's IndexedDB; clearing the whole translation cache does not remove it
- **SillyTavern's default toggle names**: built-in toggles such as `Chat History`, `World Info (before)` and `Persona Description` that still have their default names are shown with their Korean names right away, without a translation request
- **Character card field names**: field names such as description, personality summary, scenario, first message, example dialogue and alternate greetings are also shown by the extension right away without a request; 📛 sends nothing for them either
- **Reuse translations of identical toggles**: when another preset has a translated toggle with **the same name and the same text** — e.g. you edited a preset and saved it under a new name — a notice appears on load. `가져오기` (import) copies those translations. Toggles whose text changed but kept their name get only the translated title (Preset tab only)
- **📛 Title translation**: translates only the titles, quickly. Several titles are sent in one request. Stored separately from body translations.
- **👀 Show translated titles**: switches the toggle titles shown in the panel to their translations; press again to go back to the original
- **Custom target language**: pick `⚙️ 직접 입력` in the dropdown and type the language you want (an English language name works best, e.g. French).
- **World Info keyword translation**: an entry's primary keywords and optional filter are shown at the top of the translated body and correspond to the `key` and `keysecondary` fields on JSON export.
  - Primary keywords keep the originals; translations are only **added**.
  - Secondary keywords depend on the entry's Logic setting. `AND ANY` and `NOT ANY` are merged like primary keywords, but `AND ALL` and `NOT ALL` require *every* term to match, so adding items would stop the entry from ever firing. For those two, the translated terms **replace** the originals instead, meaning such entries work only in the target language.
- **World Info entry info**: expanding an entry shows its activation mode (🔵 constant / 🟢 keyed / 🔗 vectorized), position, depth, order and trigger % in small text
- **Rate control**: the extension drawer lets you set the title-translation batch size and the delay between requests (ms). Raise the delay if you hit an API per-minute limit (e.g. Vertex AI). (1000ms = 1 second)
- Per-provider sampling parameters can be configured individually

### Bundled regex & scripts
When a preset or character card carries regex scripts or JS Runner scripts, folded `동봉 정규식 n` (bundled regex) and `동봉 스크립트 n` (bundled scripts) sections appear at the bottom of the list.

- **Regex**: one line with the name only (does not expand). ✦ Translate, ↺ Retranslate and 📛 Titles all work exactly like 📛 title translation: names are translated in batches and shown translated as soon as they're done
- **Scripts**: expand like toggles, showing the name and description (the text behind the ⓘ in JS Runner). ✦ Translate translates name + description; 📛 Titles translates names only.
- The `전체 선택` (select all) at the top applies to toggles only; each section has its own `이 섹션 전체 선택` option.
- Search and 👀 cover the sections too; a section opens when it holds a search match
- These translations are **for reading in the panel only**: they never go into copy, TXT or JSON exports or the JS Runner title script, and are not counted as tokens.

### Search
Keyword search runs against both the original and translated text. Matching parts are highlighted inline in the panel.

### Token count
The total token count of all loaded items, the **sum of the toggles that are switched on (ON)**, and the sum for the selected toggles are shown. Right after loading an estimate is shown, which is then replaced by the exact count from SillyTavern's tokenizer.
- `{{// comments }}`, which never reach the prompt, are left out of the count (the displayed text is unchanged).
- World info entries are counted without their keyword lines; their ON sum is the sum of the enabled entries.
- What other macros such as `{{setvar}}` actually output is not calculated, so the count can differ from what SillyTavern really sends.

### Ask (beta)
Tap the speech-bubble button in the panel header to ask the AI about the preset, world info or character card loaded in the current tab. It uses the same API settings as translation.

- e.g. "Which toggle controls reply length?", "Why is dialogue colored?", "What is this character's family like?"
- Tap a **#number** in the answer to jump to that item and expand the toggle/entry. A number that doesn't exist in the material is marked as unverified.
- Scope: everything loaded, or only the selected items.
- **Regex scripts and JS Runner scripts bundled** with a preset or character card are read too. Regex: `names only` (default) / `full` / `off`; scripts: on or off.
- Character cards can include their **embedded lorebook** (with an `enabled entries only` option).
- Before sending, the estimated tokens and the model are shown. Oversized material is trimmed automatically, and you are told.
- The ↻ button under the last answer gets a new answer. If that fails or is stopped, the previous answer stays, and a question that ended in an error can be resent with the same button.
- While waiting, `Send` turns into `Stop`.
- The 🔖 button under an answer saves it to the **archive**. Each preset, world info book and character has its own archive, opened with the `보관함` (archive) button at the top of the Ask window. Tap a card to expand the full answer; cards can be deleted one by one or all at once. Saved in the browser's IndexedDB, so it survives a SillyTavern reload (clearing the translation cache does not touch it).
- Each loaded item keeps its own conversation. It survives closing the window and loading another item in between, but reloading SillyTavern clears it.
- On the Preset tab, Ask has **ready-made question buttons**: length · language · point of view · NSFW · impersonation · pacing · status panel/choices · must-have toggles. Tapping one sends it right away. `What is this?` asks what each toggle selected in the panel (up to 10) does.
- Material size, answer length and temperature can be set in the `Ask` section of the extension settings.

Good to know
- **Read-only.** Even if the answer says "change this toggle like so", the extension never edits anything.
- **Global and character/chat-scoped regex are not read.**

### Preset compare (beta)
The small ⇄ tab next to `Preset` compares two presets toggle by toggle.

- **A** = the base (older / original), **B** = the one to compare (newer / your edit). ⇅ swaps them.
- e.g. A=`original preset`, B=`my custom` → see at a glance what you changed
- Filter chips: `All` · `Changed` (default) · `Added` · `Removed` · `Content` · `ON/OFF` · `Order` · `Name` · `Position/Role` (including generation triggers and override protection) · `Other` (preset values, bundled regex and scripts) · `Same`
- `All` lists every toggle in B's order, with unchanged ones dimmed.
- Toggles with the same name on both sides are treated as the same toggle. Toggles whose names repeat (separators and the like) or that were renamed are matched by SillyTavern's internal identifier; a renamed toggle shows its previous name when expanded.
- Expand a row to see what changed: `−` struck-through red exists only in A, `+` green only in B. Unchanged lines are folded and open on tap.
- If the preset has been translated, the translated title and a `translation reference` are shown too.
- `Copy A` / `Copy B` put the original text on the clipboard.
- **Read-only.** The currently selected preset is read from its unsaved working state for toggles, and from its saved copy for preset values. API connection settings are never read or shown.

#### Preserving originals
Keep a received preset's original state before you start editing it, and later compare "original → my edit" in the compare tab.
- Load a preset in the Preset tab and press `📥 원본 보존` at the end of the second row (swipe the row sideways). The preset is kept **exactly as saved in SillyTavern**; unsaved edits and connection fields such as the proxy address and password are left out.
- One per preset name. If an original is already kept, you are asked before it is replaced.
- Pick it from `보존본` at the top of the A list in the compare tab. Leave A empty and pick B, and B's original is put into A automatically — by name if you kept editing the same preset, or by how many toggles overlap if you saved your edit under another name. If several could match, you are asked to choose.
- An original that was **put into A automatically follows B** (switching to the new B's original)
- No original kept? Use `📁 파일에서 열기` in the A list to bring in a preset JSON file directly and compare. It is kept only for this session and stored nowhere, unless you choose to keep it as an original.
- The `프리셋 원본 보존` section of the extension settings lists originals and deletes them.
- `실리태번에서 프리셋을 가져올 때 자동으로 보존` keeps a copy whenever you import a preset through SillyTavern (off by default; an existing original of the same name is never replaced).
- Originals live only in this browser's IndexedDB. When moving devices, tick `보존된 원본도 함께 백업` in the cache backup.

### Copy & Export
Each tab (Preset / World Info / Character) has three icon buttons in the top-right area.

- **Copy** — copy to clipboard
- **TXT export** — save as a text file
- **JSON export** — save as a SillyTavern-compatible JSON file

#### Copy / TXT export
You can select only some toggles and copy/export just those. When you trigger the action you choose between **Original / Translated / Both**. Untranslated items show up as `(번역없음)` in the "Translated" mode.

#### JSON export
- **Preset** is **always exported in full**, regardless of selection (so the structure stays valid). **Embedded regex scripts and other extension settings are exported alongside the prompts**.
- **World Info** exports only the selected entries when partial selection is used.
- **Character Card** applies translations only to the selected fields when partial selection is used. **If the card contains an embedded `character_book`**, you'll be asked whether to include it; if you choose to include it, it is exported as-is (original content).
- Toggle titles are translated too. On JSON export, the translated title is placed back into the proper name field (`name` for preset prompts, `comment` for world info entries).

#### JS Runner title-translation script
On the Preset and World Info tabs, the JSON export button opens a format picker. Choosing **JS Runner title-translation script** generates a script that makes the titles appear translated inside SillyTavern's own UI. Import it into the JS-Slash-Runner extension (Tavern Helper).

- Preset: shows prompt manager entry names as their translations.
- World Info: adds the translated title as a hint above each entry title. Input values are never touched, so your world info data does not change.
- It only changes what is displayed. Disabling the script in JS Runner puts the original names back and removes the hints.
- Names another extension has already changed are left alone. If several extensions translate prompt names at once, only the first one shows, so enabling just one is recommended.
- It does not react to screen changes during chat. The World Info script only acts when the entry list changes.

#### File name
Files are auto-named as `{sourceName}_{targetLanguage}.{extension}` and saved to the browser's default download folder.

### UI
- **Floating icon**: optional, draggable on-screen icon 🐳 that opens the panel from anywhere
- Preset / World Info / Character tabs
- Refresh button in the panel header — instantly syncs newly added/removed items from SillyTavern (translation cache is preserved)
- Adjustable font size for both original and translated text
- Six themes: Dark, Light, Pink, Mint, Orange, Blue
- The status bar also shows the translation model currently configured.

### Target Languages
Korean, English, Japanese, Chinese (Simplified), Chinese (Traditional), Polish. Any other language can be typed in.

## Installation

Choose one of the following:

1. Install via SillyTavern's extension manager using the GitHub URL  
2. Download the zip from this repository and extract it into `data/default-user/extensions/` inside your SillyTavern folder.

## Notes

- All exports work on a deep clone of the source data and modify only the clone, so **your original presets, world info, and character cards are never modified.**
- When a translation fails (error, safety-filter block, empty reply), the item shows the reason and any existing translation is kept. A reply cut off by the output length limit is not saved either — but **for Claude and Google (Gemini), SillyTavern does not pass on why a reply ended**, so a cut-off translation may go unnoticed.
- The character card JSON export uses the V3 spec's `data.*` path as the source of truth and clears the V1-compat top-level duplicates to keep the file lean. SillyTavern reads `data.*` first on import, so compatibility is unaffected.

## Changelog

### 1.2.0

The first update since 1.1.0. Existing translations and settings carry over.

**New**
- 🔍 **List search**: tapping the name box opens a searchable list. Search by part of a name, several words, or Korean initial consonants (`ㄲㅆ` → 꽃씨); the five most recently loaded items are listed first. Pick, then `📂 로드` to load
- 📛 **Name translation**: translate the names of presets, world info and character cards themselves, shown inside the panel (switch with 👀; translated names are searchable)
- 💬 **Ask (beta)**: ask the AI about the loaded preset, world info or character. `#number` links in answers jump to the toggle; bundled regex/scripts and embedded lorebooks are read too; quick-question buttons on the Preset tab; regenerate and stop; 🔖 answer archive
- ⇄ **Preset compare (beta)**: compare two presets toggle by toggle. Filter by added, removed, content, ON/OFF, order, name and more; line- and character-level differences; settings and bundled regex/script differences
- 📥 **Preserving originals**: keep a received preset's original and compare your edited copy with it on the compare tab. Without a kept copy, open the file directly; optional auto-keep on import (off by default)
- 🧩 **Bundled regex & scripts**: regex and JS Runner scripts inside presets and character cards are listed below the toggles; names and descriptions can be translated
- 🔁 **Reuse translations of the same source**: when another preset has a toggle with the same name and text, the panel offers its translation
- 💾 **Translation cache backup & import**: back up and restore all translations as a file (optionally with kept originals)
- 🌐 **Translation quality**: preset-specific rules (model names not translated literally, version codes and instruction strength kept), a preset glossary (tells the model what community slang means, editable in settings), and Korean names for SillyTavern's built-in toggles and character card fields without a request
- 🔢 **Token count**: exact counts with SillyTavern's tokenizer, total of ON toggles, `{{// comments }}` and world-info keyword lines left out

**API connection**
- **Custom (OpenAI-compatible)** added: enter an address and API key to connect any other service; `모델 목록 불러오기` checks the connection. A typed key is kept only in the browser; with the box empty, a key SillyTavern holds for the same address is used
- Mistral, Groq, Cohere and xAI entries removed (use Custom or OpenRouter; existing settings keep working)
- Model lists updated to the models each vendor officially serves as of November 2026 (Gemini 4, Claude Fable 5.2 / 5.5 family, GPT-6 family and more)
- Following each vendor's guidance, temperature and other sampling values and the prefill are not sent to the newest models
- Fixed Claude translation and Ask failing; response length limit 16000 for the Claude 5 / Fable family
- OpenAI o3 / gpt-5 requests tidied the way SillyTavern does
- Error messages unified as `API status — reason`, with plain explanations for common authentication and limit errors

**Settings & look**
- Extension settings grouped into folding sections (they open at once)
- Fixed number boxes being unreadable on dark themes

**Fixes**
- Failed translations show the reason on the item and the failure count in the status line
- A failed or cut-off re-translation keeps the previous translation
- Target language can no longer change mid-translation; a notice when the browser storage cannot save
- Shared preset JSON exports strip more connection fields
- Exporting the currently selected preset as JSON no longer mixes in SillyTavern settings
- Exporting after picking another item in the list no longer downloads the wrong file
- Translations loaded with `— 선택 —` no longer mix with other presets (older ones can be restored with `가져오기` on the notice bar)
- Loading another item mid-translation no longer mixes up the screen; 🐳 no longer stays off-screen after rotation
- Search: highlighting no longer breaks text, translated titles are now found, and more
- Blocked unusual values in shared world info from running in the panel (security)
- JS Runner title scripts improved: restore on disable, never overwrite each other with other translation extensions, lower load during chat and idle (**export again to apply**)

### 1.1.0 (2026-07-28)

- 📛 **Title translation**: translate titles only, several per request (stored apart from full translations)
- **JS Runner title-translation script** export: shows translated prompt names in SillyTavern's own UI (preset) and translated hints above entry titles (world info)
- **Custom target language** (`⚙️ 직접 입력`)
- **World info keyword translation**: keywords and secondary keywords are translated with the entry and restored on JSON export (primary keywords keep the originals and add translations; secondary keywords are merged or replaced depending on Logic)
- **World info entry details**: activation mode, position, depth, order, trigger%
- **Request pacing**: title batch size and delay between requests
- The current translation model is shown in the status line
- Z.AI (GLM) provider added; model lists updated (Gemini 3.5 / 3.6, DeepSeek V4 and more)
- Panel design refreshed

### 1.0.0 (2026-04-29) — first release

- Load and view SillyTavern presets, world info and character cards in a panel
- Per-toggle / per-entry / per-field translation and re-translation; translation cache in the browser's IndexedDB
- Ten providers, per-provider sampling values, reverse proxy and prefill.
- Search with highlighting across original and translated text
- Token counts for all and for selected toggles
- Copy, TXT and JSON export (original / translation / both, translated titles applied, optional embedded lorebook)
- Floating button, refresh, font sizes, six themes, six target languages

Fixes shipped after 1.0.0 without a version change:
- 2026-04-29: Vertex AI express mode and region are read from SillyTavern's settings (requests failed in express mode)
- 2026-05-03: the hidden panel no longer takes up space on wide screens or with a sideways swipe on mobile, covering SillyTavern's dialogs
- 2026-05-04: the refresh button now picks up presets, world info and characters added or removed in SillyTavern
- 2026-05-27: 👀 title view added; toggles with a name but no content are translated too

## Credits

Up to 1.1.0, the API connection logic (provider handling, sampling parameters, etc.) was written with reference to the following extensions.

- [llm-translator](https://github.com/1234anon/llm-translator) by 1234anon
- [llm-translator-custom](https://github.com/NamelessKkang/llm-translator-custom) — a fork of the above

Both are licensed under AGPL-3.0.

From 1.2.0 on, the API connection code has been rewritten from scratch.

## License

AGPL-3.0. See [LICENSE](LICENSE) for the full text.
