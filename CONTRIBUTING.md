# Contributing to n8n-nodes-baserow-plus

Thanks for your interest in contributing!

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Copy the node files into your n8n custom nodes directory for testing
4. Make your changes
5. Test against a real Baserow instance (we don't mock the database)

## Development Setup

This is an n8n community node. To test locally:

```bash
# Copy to your n8n custom nodes directory
cp -r . ~/.n8n/custom/n8n-nodes-baserow-plus/

# Restart n8n
docker restart n8n
```

## Pull Requests

- Keep PRs focused on a single change
- Update the README if you add or change operations
- Add an entry to CHANGELOG.md
- Test against both self-hosted Baserow and baserow.io if possible

## Reporting Bugs

Open an issue with:
- n8n version
- Baserow version (self-hosted or baserow.io)
- The operation you were using
- Expected vs actual behavior
- Any error messages (the node provides human-readable errors — include those)

## Code Style

- This is a single-file node (`BaserowPlus.node.js`) — keep it that way
- Follow the existing patterns for new operations
- All field serialization goes through `serializeFieldValue()`
- All error formatting goes through `parseBaserowError()`

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
