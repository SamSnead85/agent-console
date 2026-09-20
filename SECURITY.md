# Security

Agent Console reads local session logs that may contain private work. It binds
only to `127.0.0.1`, pins allowed Host values, requires request intent for API
calls, and denies cross-origin embedding unless specific origins are configured.
Known credential patterns are redacted; redaction cannot identify every private
business detail. Use demo mode for screenshots and public presentations.

Do not proxy the live console onto a public interface. Do not submit real
transcripts, tokens, credentials, or customer data in issues. The application
does not terminate agents or expose a session-ingestion API. Derived local
history is retained outside the repository; uninstalling does not delete it.

Report vulnerabilities using this repository's GitHub private vulnerability
reporting feature. Include a synthetic reproduction and affected version.
