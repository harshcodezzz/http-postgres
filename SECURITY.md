# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately by emailing [harsh@1st-services.com](mailto:harsh@1st-services.com).

Include enough information to reproduce and assess the issue when it is safe to do so:

- the affected version or commit;
- the affected endpoint, component, or configuration;
- reproduction steps or a minimal proof of concept;
- the potential impact;
- any suggested mitigation;
- whether the issue has been disclosed elsewhere.

Do not include live credentials, API keys, customer data, or other third-party secrets. Use synthetic data and redact sensitive logs.

## What to expect

The maintainer will acknowledge the report, investigate its impact, and coordinate remediation and disclosure directly with the reporter. Response and resolution times depend on the severity and complexity of the issue.

Please allow a reasonable remediation period before public disclosure. If the report is out of scope or cannot be reproduced, the maintainer will explain that conclusion where practical.

## Scope

Security reports may cover the HTTP PostgreSQL Gateway source code and its documented deployment behavior. Vulnerabilities in Node.js, PostgreSQL, Redis, or another third-party dependency should also be reported to the relevant upstream project when appropriate.

Operational questions, feature requests, and ordinary bugs should use the project's normal issue workflow rather than the private security address.

## Supported versions

This project is under active development. Security fixes are provided for the latest released version. Users should upgrade to the newest release before reporting an issue that may already have been resolved.
