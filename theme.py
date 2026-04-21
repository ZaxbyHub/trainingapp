"""Theme module providing design tokens for consistent UI appearance."""

import customtkinter as ctk


# Font family constant for TypeScale
FONT_FAMILY = "Segoe UI"


class ColorTokens:
    """Adaptive color tokens — resolves at read-time based on CTk appearance mode."""

    @classmethod
    def _is_dark(cls) -> bool:
        mode = ctk.get_appearance_mode()
        return mode.lower() in ("dark",)

    # Primary brand color (same in both modes)
    @classmethod
    def primary(cls) -> str:
        return "#1a73e8"

    @classmethod
    def primary_hover(cls) -> str:
        return "#1557b0"

    # Secondary/neutral
    @classmethod
    def secondary(cls) -> str:
        return "#444444" if cls._is_dark() else "#8a8a8a"

    @classmethod
    def secondary_hover(cls) -> str:
        return "#555555" if cls._is_dark() else "#6b6b6b"

    # Semantic
    @classmethod
    def danger(cls) -> str:
        return "#d32f2f"

    @classmethod
    def danger_hover(cls) -> str:
        return "#b71c1c"

    # Text on colored backgrounds
    @classmethod
    def text_on_primary(cls) -> str:
        return "#ffffff"

    @classmethod
    def text_on_secondary(cls) -> str:
        return "#ffffff" if cls._is_dark() else "#ffffff"

    @classmethod
    def text_on_bubble(cls, role: str) -> str:
        """Return appropriate text color for bubble role."""
        if role == "user":
            return "#ffffff" if cls._is_dark() else "#1a1a2e"
        elif role == "assistant":
            return "#e0e0e0" if cls._is_dark() else "#1a1a2e"
        else:  # system
            return "#cccccc" if cls._is_dark() else "#555555"

    # Chat bubble backgrounds
    @classmethod
    def bubble_user(cls) -> str:
        return "#2b5278" if cls._is_dark() else "#d0e3f5"

    @classmethod
    def bubble_assistant(cls) -> str:
        return "#1a1a2e" if cls._is_dark() else "#f0f0f5"

    @classmethod
    def bubble_system(cls) -> str:
        return "#2d2d2d" if cls._is_dark() else "#e8e8ec"

    # Source pill
    @classmethod
    def source_pill_bg(cls) -> str:
        return "#3a3a4e" if cls._is_dark() else "#dde4ed"

    @classmethod
    def text_muted(cls) -> str:
        return "#94a3b8" if cls._is_dark() else "#64748b"


class TypeScale:
    """Typography scale — returns CTk-compatible font tuples."""

    @classmethod
    def display(cls) -> tuple:
        return (FONT_FAMILY, 24, "bold")

    @classmethod
    def h1(cls) -> tuple:
        return (FONT_FAMILY, 20, "bold")

    @classmethod
    def h2(cls) -> tuple:
        return (FONT_FAMILY, 16, "bold")

    @classmethod
    def h3(cls) -> tuple:
        return (FONT_FAMILY, 14, "bold")

    @classmethod
    def body(cls) -> tuple:
        return (FONT_FAMILY, 13, "normal")

    @classmethod
    def caption(cls) -> tuple:
        return (FONT_FAMILY, 11, "normal")

    @classmethod
    def small(cls) -> tuple:
        return (FONT_FAMILY, 10, "normal")


class Spacing:
    """4px base grid spacing system."""

    XS = 2
    SM = 4
    MD = 8
    LG = 12
    XL = 16
    XXL = 20
    XXXL = 24
    SECTION = 32

    # Compound presets
    INPUT_PAD = (XL, 0, 0, 0)
    CARD_PAD = (LG, LG, LG, LG)
    SECTION_PAD = (0, LG)
    FRAME_PAD = (XXL, XXL)
    BAR_PAD = (MD, LG)
