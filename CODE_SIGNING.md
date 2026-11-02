# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io),
certificate by [SignPath Foundation](https://signpath.org).

## What is signed

The Windows release files built from this repository by
`.github/workflows/build-windows.yml`: the installer (`RadTempo-Setup.exe`),
the portable app and the helper (`RadTempoHelper.exe`) inside them. Each
is built from this repository's source in GitHub Actions and signed there;
nothing is signed by hand or built on a personal computer.

## Team roles

| Role | Who |
|---|---|
| Committers and reviewers | Avecina Studio |
| Approvers (approve each signing request) | Avecina Studio |

## Privacy

This program does not send any information to other networked systems
unless the user asks for it. The only connection it can make on its own is
to a calendar address the user enters in Settings > Schedule, to read that
user's shift times; it is off until an address is entered. Everything else
stays on the computer, in the user's own data folder. See
[SECURITY.md](SECURITY.md) for the full list.
