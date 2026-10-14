---
name: fontpool-typography
version: 1.0.0
description: >
  Choose and self-host real typefaces with the fontpool MCP server. Use
  whenever you are about to set a font-family — styling a UI, building a page
  or component, setting up a design system, restyling a landing page, or
  picking type for anything that renders. Consult the catalog before naming a
  font, because an unassisted guess lands on the same handful of Google Fonts
  every time. Do NOT activate for work that renders no type.
requires_mcp: fontpool
---

# Fontpool Typography

An AI writing CSS reaches for `Inter`, `Roboto`, `Open Sans`, `Montserrat` or
`Poppins` nearly every time. Not because they were chosen — because they are
the most probable tokens, and because they are the ones it is *certain* can be
loaded. The result is competent and anonymous.

This skill exists to put one step between "this needs a sans-serif" and typing
a font name: ask fontpool what is actually installable, read what the foundry
says about it, then choose deliberately. 2,168 families are available and about
192 of them are not Google Fonts.

---

## When to use this skill

Any time type will render:

- Styling or restyling a page, component, or whole UI
- Setting up or extending a design system, theme, or token set
- Landing pages, marketing pages, dashboards, documentation sites
- Picking a display face for a heading, a text face for body copy, a mono for code
- A request that implies a visual identity ("make this feel more premium")

Skip it when no type is rendered: backend work, data pipelines, CLI output,
tests, infrastructure.

---

## Prerequisites

The fontpool MCP server must be connected. It needs no API key.

---

## Workflow

### Step 1 — Say what the type has to do

Before querying, name the job in one line: *display face for a fintech
dashboard, needs to read as precise and current*. That line is what you will
filter and judge against. Signals worth extracting from the conversation:

- **Register** — precise, warm, editorial, playful, austere, premium
- **Role** — display/headline, body text, UI label, code
- **Constraints** — language coverage, variable axis, weight range, licence

### Step 2 — Query the catalog, do not recall from memory

```
list_fonts { category: "serif", tag: "editorial" }
list_fonts { exclude: ["google"], category: "sans-serif" }
list_fonts { category: "monospace", tag: "code" }
list_fonts { hasAxis: "wdth" }
```

`list_fonts` with no arguments returns the shape of the catalog — category
counts, the tag vocabulary and the axis vocabulary — which is how you discover
what the filters accept. Always pass at least one filter when you want names;
the unfiltered name list is 2,168 families and is never the useful answer.

`exclude: ["google"]` is the important one. It leaves only families Google's
catalog does not carry, which is the entire reason to consult a catalog rather
than your own priors.

`hasAxis` finds capability you cannot infer from a name: 97 of the 2,168
families have a width axis, 32 have optical size, and a handful carry
expressive axes like `CASL` or `MONO`. If the design calls for a condensed
heading or type that holds up at two very different sizes, that is a filter,
not a guess.

### Step 3 — Read the description before choosing

```
font_properties { family: "Zodiak" }
```

This returns the foundry's own account of the design, plus category, tags,
foundry, designers, licence, weights, styles and subsets. Read it. "Zodiak" is
not a decision; "sturdy serifs, several weights optimal for running text, the
extremes work together in display" is.

Treat `description` as what it is — the foundry's marketing copy, flagged as
such in `descriptionSource`. It is reliable about the design and enthusiastic
about its merits. Discount accordingly.

`variableAxes` lists every axis with its range, which is often the deciding
detail: a single variable file that covers 300–900 plus a slant is a different
proposition from four static weights. Lowercase tags are the registered axes
(`wght`, `wdth`, `slnt`, `ital`, `opsz`); uppercase ones are foundry-defined.

Confirm the weights you intend to use actually exist here, before installing.

### Step 4 — Install, self-hosted

```
install_font {
  family: "Switzer",
  targetDir: "./public/fonts",
  cssPath: "./src/index.css",
  weights: ["400","700"]
}
```

Prefer a `cssPath` the project **already imports**. A fresh `fonts.css` that
nothing imports is the one failure that looks like success — the tool will warn
you when it cannot find a reference to the file, and that warning means the
font will not render until you wire it up.

`targetDir` is a disk path; `urlPrefix` is the public URL the CSS points at.
If the static root is `public/`, then `./public/fonts` pairs with `/fonts`.

### Step 5 — Say why, in one line

Report the choice with its reason and its provenance: *Switzer (ITF, via
Fontshare) — neo-grotesk, classic without being Helvetica, 18 styles including
italics.* One line. The user can overrule a reason; they cannot overrule a bare
name.

---

## Judgment

- **Offer, don't swap.** If the user named a font, install that font. You may
  note an alternative in one line; you may not quietly substitute.
- **A considered Google font is fine.** The goal is a choice, not an aversion.
  If Inter is genuinely right, use Inter — and say why it beat the alternative.
- **Pair deliberately.** A display face plus a text face is usually two
  `install_font` calls, not one font stretched across both jobs.
- **Variable when it earns it.** Pass the range (`["100 900"]`) for one file
  covering every weight; pass static weights when you need two or three. Check
  `variableAxes` first — the range in `weights` is the weight axis only, and a
  family may carry width or optical size as well.
- **Respect the licence.** `license` comes back from `font_properties`. Adobe
  fonts are absent on purpose — their terms forbid self-hosting.

---

## Error handling

- **Name not found** — the error suggests near matches; take one rather than
  re-guessing.
- **"exists, but not in the combination you asked for"** — the family is right
  and the weights are wrong. Read the weights it lists; do not re-check the name.
- **Empty catalog** — the provider APIs are unreachable. Say so; don't fall
  back to a hardcoded font name without telling the user it is unverified.
- **No workspace root** — `install_font` needs absolute paths. Ask for the
  project path rather than guessing.

---

## What not to do

- Do not write a `font-family` for a new design without querying the catalog first
- Do not call `list_fonts` with no filters expecting a list of names
- Do not recommend a font that is not in the catalog as though it were installable
- Do not install into a stylesheet nothing imports and report success
- Do not substitute a font the user asked for by name
- Do not present the foundry's description as neutral fact
- Do not add a separate "typography" section to an unrelated deliverable
