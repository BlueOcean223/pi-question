# Changelog

## [1.3.0] - 2026-11-16

### Added

- While a question is open, pi reports itself as blocked through its program status (OSC 7501), so terminals and dashboards that read it show pi as waiting on you instead of working. This needs pi 1.5.0 or later. The report gives the number of open questions, never their text.

## [1.2.0] - 2026-10-10

### Changed

- A question now waits for an answer for as long as it takes. It used to submit whatever was selected after 5 minutes without input. Set `PI_QUESTION_AFK_TIMEOUT` to a duration such as `90s`, `5m` or `1h` to turn the idle submit back on.

### Added

- While a question is open, the `herdr:blocked` event tells herdr to mark the pane as waiting on you.

### Fixed

- Left and Right inside the free-text row or a note now move the cursor instead of switching questions. While editing, Tab and Shift+Tab switch questions.
- "Chat about this" now marks typed answers in what the model reads, so a typed answer no longer looks like one of the model's own options.

## [1.1.1] - 2026-10-02

### Fixed

- `ask_user_question` can no longer be called from codemode scripts. A script received the answer as bare text without attached images, and with `codemode.mode: "only"` the model could not open the dialog at all. The tool is also marked read-only, so permission extensions do not ask before a question is shown.

## [1.1.0] - 2026-09-22

### Added

- Images in answers: Ctrl+V attaches the clipboard image, and an image path typed or dropped into an answer is sent to the model as an image next to the text.

## [1.0.0] - 2026-08-27

- First release on npm, as `@blueocean223/pi-question`.
