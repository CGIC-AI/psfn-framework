from __future__ import annotations

import typer

from hub.cli.probe import probe, transport_spike
from hub.cli.run import run

app = typer.Typer(no_args_is_help=True, pretty_exceptions_enable=False)
app.command("probe")(probe)
app.command("transport-spike")(transport_spike)
app.command("run")(run)


def main() -> None:
    try:
        app()
    except typer.Exit:
        raise
    except Exception:
        typer.echo("Hub operation failed; verify configuration and service availability", err=True)
        raise typer.Exit(1) from None
