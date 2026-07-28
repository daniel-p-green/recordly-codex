# Security policy

## Supported versions

Security fixes are applied to the latest version on `main` until a stable release line is established.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability-reporting feature for this repository when available. If private reporting has not been enabled yet, contact a maintainer privately through the repository profile and include:

- A clear description of the issue and affected component.
- Minimal reproduction steps or proof of concept.
- Security impact, including whether secrets, recording data, browser permissions, or arbitrary code execution are involved.
- Suggested mitigation, if known.

Do not include real credentials, cookies, customer data, or sensitive recordings in a report. We will acknowledge a valid report, investigate it, and coordinate disclosure before publishing a fix.

## Security boundaries

This project must not bypass site authentication, CAPTCHA, anti-bot protections, browser permission prompts, or user confirmations. Treat recordings and browser artifacts as sensitive by default and keep them outside the repository.
