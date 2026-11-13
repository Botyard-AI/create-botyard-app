# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**Security → Report a vulnerability** on this repository
([direct link](https://github.com/Botyard-AI/create-botyard-app/security/advisories/new)).
Do not open a public issue.

Include what is affected (package and version), how to reproduce it, and the
impact you see. We aim to acknowledge reports within 3 working days and to agree
a disclosure date with you.

## Supported versions

Until 1.0, only the latest published version of each package receives fixes.

## Verifying what you install

Every package is published from GitHub Actions with npm trusted publishing, so
each version carries a provenance attestation that links it to the commit and
workflow that built it:

```sh
npm audit signatures
```

`create-botyard-app` copies templates from its own published package. It never
downloads code from this repository at run time and runs no install scripts.

## Scope

In scope: the packages and templates in this repository. If you find a
vulnerability in the Botyard platform itself, report it here the same way and we
will route it.
