"""Launch the vendored LoopX wheel with only its private package directory."""

from pathlib import Path
import sys


def main() -> None:
    """Run LoopX's packaged CLI entry point."""
    packages = Path(__file__).resolve().parent / "python-packages"
    sys.path.insert(0, str(packages))
    from loopx.entrypoint import main as loopx_main

    loopx_main()


if __name__ == "__main__":
    main()
