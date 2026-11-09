"""Wire translators: JSON dialect <-> canonical IR.

`anthropic_in` / `anthropic_out` are the client-facing edge. `openai_out` builds the
chat-completions request the `openai_compatible` provider (Ollama) sends upstream.
"""
