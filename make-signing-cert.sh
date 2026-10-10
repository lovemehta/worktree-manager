#!/bin/zsh
# Creates a local self-signed code-signing certificate "WorktreeMenu Dev" in the login keychain.
# With it, rebuilds of WorktreeMenu.app keep the same signing identity, so the macOS
# Accessibility grant survives rebuilds (ad-hoc signatures change on every build).
set -euo pipefail
NAME="WorktreeMenu Dev"
KC="$HOME/Library/Keychains/login.keychain-db"
if security find-identity -v -p codesigning | grep -q "$NAME"; then echo "Identity '$NAME' already exists."; exit 0; fi
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$NAME" \
  -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning" \
  -keyout "$T/key.pem" -out "$T/cert.pem" >/dev/null 2>&1
openssl pkcs12 -export -inkey "$T/key.pem" -in "$T/cert.pem" -out "$T/id.p12" -passout pass:wm -legacy 2>/dev/null \
  || openssl pkcs12 -export -inkey "$T/key.pem" -in "$T/cert.pem" -out "$T/id.p12" -passout pass:wm
security import "$T/id.p12" -k "$KC" -P wm -T /usr/bin/codesign -T /usr/bin/security >/dev/null
# Trust it for code signing (macOS may ask for your login password once).
security add-trusted-cert -r trustRoot -p codeSign -k "$KC" "$T/cert.pem"
security find-identity -v -p codesigning | grep "$NAME" && echo "Created identity '$NAME'."
