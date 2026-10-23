from __future__ import annotations

import logging


# Only these code-owned event templates may reach a logging transport. Dynamic
# arguments, traceback text and all third-party prose are discarded beforehand.
_EVENTS = frozenset({
    "Voice turn started", "Replacing active turn", "Voice turn failed",
    "Voice turn interrupted", "Voice turn reply timed out",
    "Voice turn drain completed after local finalization",
    "Dropping audio chunk because no active turn exists", "Received stop without an active turn",
    "Interrupting active response pipeline", "Response pipeline failed while interrupting active output",
    "Agent stream stalled after partial reply", "Failed to speak fallback error message",
    "Failed to start realtime STT turn", "Audio request failed",
    "Voice transport started", "Voice transport stopped",
    "Dropping audio chunk because no active conversation exists", "Received stop without an active conversation",
    "Resetting lingering Deepgram turn", "Ignoring non-JSON PSFN stream payload",
    "Artifact cleanup failed",
})


def install_private_logging() -> None:
    previous = logging.getLogRecordFactory()
    if getattr(previous, "_hub_private_logging", False):
        return

    def private_record(*args, **kwargs):
        record = previous(*args, **kwargs)
        event = record.msg if isinstance(record.msg, str) and record.msg in _EVENTS else "Runtime diagnostic"
        record.msg, record.args = event, ()
        record.exc_info = record.exc_text = record.stack_info = None
        record.name = "hub" if record.name.startswith("hub.") else "dependency"
        record.pathname, record.filename, record.module, record.funcName = "hub", "hub", "hub", "runtime"
        record.threadName = record.processName = "runtime"
        record.taskName = None
        return record

    private_record._hub_private_logging = True
    logging.setLogRecordFactory(private_record)
