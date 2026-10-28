# Russian localization

Russian uses the built-in locale `ru`. System detection recognizes regional and POSIX tags such as `ru-RU`, `ru-KZ` and `ru_RU.UTF-8`. Renderer catalogs and native menu translations load lazily. The selected language also supplies the locale for the existing number, date, relative-time and weekday formatters. Paired web clients keep their language preference locally when a server is older or offline.

The nested i18next catalog lives at `src/renderer/src/i18n/locales/ru.json`. Missing translations use the current English fallback. Standalone React Native mobile screens have separate copy; the shared desktop renderer used by paired web clients uses this catalog. Provider transcripts, approval options, user content and third-party plugin content retain their original language.

## Translation workflow

Keep inline English defaults and `en.json` synchronized with the current source. Run `pnpm run sync:localization-catalog` to add missing literal defaults and `pnpm run sync:localization-runtime-catalog` to regenerate the English boot subset. Apply reviewed translations with `node config/scripts/apply-translation-delta.mjs <delta.json>`, which rejects empty values and changed placeholders.

Translate complete phrases in context. Preserve product names, command syntax, paths and interpolation variables. Reuse a translation only after checking both the English source and its UI meaning. Native language labels, technical identifiers and interpolation-only values may intentionally match English. Never exempt ordinary untranslated prose.

## Plurals and source grammar

Pass `count` for count-based messages. Russian uses `one`, `few`, `many` and `other`; test zero, singular, small plurals, teens, compound counts and fractions. The validator permits additional locale-specific forms only for an existing English `_other` family and valid CLDR categories, and checks their placeholders against that source.

Prefer a whole sentence over translated fragments or JavaScript singular/plural concatenation. Where changing legacy behavior is unnecessary, a reviewed count-neutral phrase can preserve grammar. Keep original provider content separate from application labels.

## Verification

Run these catalog checks after editing source copy or translations:

```sh
pnpm run verify:localization-catalogs
pnpm run verify:localization-extraction
pnpm run verify:localization-coverage
```

Completeness measures coverage of the current English catalog; it does not prove linguistic quality or rendered behavior.
