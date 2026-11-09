"""The canonical intermediate representation every request and response passes through.

The IR is deliberately **Anthropic-shaped**: Anthropic's typed content blocks are a
strict superset of OpenAI's chat shape, so `wire/anthropic_in.py` and
`wire/anthropic_out.py` are near-identity and the one lossy conversion (to the
chat-completions body Ollama reads) is concentrated in `wire/openai_out.py`.
"""
