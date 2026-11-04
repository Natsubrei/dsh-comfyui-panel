# Starting ComfyUI from the profile

The panel Server section is the usual way to start ComfyUI. It remembers the checkout and can start with DSH. That path needs no profile configuration. It is described in the README under Configuration.

A `supervise` block on the plugin row overrides the panel setup at startup. The block can name any command. The profile file is trusted configuration, not a panel field. See [SECURITY.md](../SECURITY.md).

```yaml
supervise:
  enabled: true
  command: /opt/ComfyUI/.venv/bin/python
  args: [main.py, --listen, 127.0.0.1, --port, '8188']
  cwd: /opt/ComfyUI
  restartDelayMs: 5000
  maxRestarts: 5
  probeIntervalMs: 20000
  startTimeoutMs: 120000
  logPath: /var/log/comfyui/comfyui.log
```

`cwd` is required when `enabled` is true. A missing value fails the plugin load instead of never starting ComfyUI. `command` defaults to `python3`. `args` defaults to `main.py --listen 127.0.0.1`.

An upstream that already answers `/system_stats` is adopted (`state: external`) rather than started again. Unloading the plugin stops only a process it started in this lifetime. An adopted server keeps running; the README section Current limits says how to stop one.
