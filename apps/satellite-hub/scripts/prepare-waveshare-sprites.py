#!/usr/bin/env python3
"""Prepare user-supplied Purrsephone sprites for the 360px round display."""

from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path

from PIL import Image


STATE_FILES = {
    "idle": "ChatGPT Image Jul 12, 2026, 07_59_58 PM (1).png",
    "thinking": "ChatGPT Image Jul 12, 2026, 07_59_58 PM (2).png",
    "sleeping": "ChatGPT Image Jul 12, 2026, 08_00_00 PM (3).png",
    "tool-use": "ChatGPT Image Jul 12, 2026, 08_02_17 PM.png",
    "talking": "ChatGPT Image Jul 12, 2026, 08_02_30 PM.png",
}


def is_background_candidate(pixel: tuple[int, int, int]) -> bool:
    """Match the near-white neutral checkerboard without keying white hair."""
    return min(pixel) >= 232 and max(pixel) - min(pixel) <= 18


def remove_connected_background(image: Image.Image) -> Image.Image:
    rgb = image.convert("RGB")
    width, height = rgb.size
    pixels = rgb.load()
    background = bytearray(width * height)
    pending: deque[tuple[int, int]] = deque()

    def enqueue(x: int, y: int) -> None:
        offset = y * width + x
        if background[offset] or not is_background_candidate(pixels[x, y]):
            return
        background[offset] = 1
        pending.append((x, y))

    for x in range(width):
        enqueue(x, 0)
        enqueue(x, height - 1)
    for y in range(height):
        enqueue(0, y)
        enqueue(width - 1, y)

    while pending:
        x, y = pending.popleft()
        if x:
            enqueue(x - 1, y)
        if x + 1 < width:
            enqueue(x + 1, y)
        if y:
            enqueue(x, y - 1)
        if y + 1 < height:
            enqueue(x, y + 1)

    rgba = rgb.convert("RGBA")
    alpha = Image.new("L", (width, height), 255)
    alpha_pixels = alpha.load()
    for y in range(height):
        row = y * width
        for x in range(width):
            if background[row + x]:
                alpha_pixels[x, y] = 0
    rgba.putalpha(alpha)
    return rgba


def fit_to_canvas(image: Image.Image, size: int = 360, inset: int = 12) -> Image.Image:
    alpha_box = image.getchannel("A").getbbox()
    if alpha_box is None:
        raise ValueError("background removal produced an empty sprite")
    cropped = image.crop(alpha_box)
    available = size - inset * 2
    scale = min(available / cropped.width, available / cropped.height)
    dimensions = (
        max(1, round(cropped.width * scale)),
        max(1, round(cropped.height * scale)),
    )
    resized = cropped.resize(dimensions, Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    position = ((size - resized.width) // 2, (size - resized.height) // 2)
    canvas.alpha_composite(resized, position)
    return canvas


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    for state, filename in STATE_FILES.items():
        source = args.source / filename
        if not source.is_file():
            raise FileNotFoundError(source)
        prepared = fit_to_canvas(remove_connected_background(Image.open(source)))
        target = args.output / f"purrsephone-{state}-360.png"
        prepared.save(target, format="PNG", optimize=True)
        print(f"{state}: {target}")


if __name__ == "__main__":
    main()
