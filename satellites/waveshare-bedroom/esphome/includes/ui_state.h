#pragma once

#include <cstdint>

namespace psfn::satellite {

enum class Page : std::uint8_t {
  Face = 0,
  Devices = 1,
  Settings = 2,
};

enum class Gesture : std::uint8_t {
  Tap,
  SwipeLeft,
  SwipeRight,
};

enum class InteractionAction : std::uint8_t {
  None,
  Headpat,
};

struct InteractionResult {
  Page page;
  InteractionAction action;
  bool page_changed;
};

class UiState {
 public:
  static constexpr std::uint32_t kHeadpatDebounceMs = 1'000;

  [[nodiscard]] Page page() const { return page_; }

  InteractionResult handle(
      Gesture gesture,
      std::int16_t x,
      std::int16_t y,
      std::uint32_t now_ms) {
    const Page previous_page = page_;
    InteractionAction action = InteractionAction::None;

    if (gesture == Gesture::SwipeLeft) {
      page_ = next_page(page_);
    } else if (gesture == Gesture::SwipeRight) {
      page_ = previous_page_in_carousel(page_);
    } else if (page_ == Page::Face && is_head_hit(x, y) && headpat_ready(now_ms)) {
      has_headpat_ = true;
      last_headpat_ms_ = now_ms;
      action = InteractionAction::Headpat;
    }

    return {page_, action, page_ != previous_page};
  }

 private:
  static constexpr Page next_page(Page page) {
    switch (page) {
      case Page::Face:
        return Page::Devices;
      case Page::Devices:
        return Page::Settings;
      case Page::Settings:
        return Page::Face;
    }
    return Page::Face;
  }

  static constexpr Page previous_page_in_carousel(Page page) {
    switch (page) {
      case Page::Face:
        return Page::Settings;
      case Page::Devices:
        return Page::Face;
      case Page::Settings:
        return Page::Devices;
    }
    return Page::Face;
  }

  static constexpr bool is_head_hit(std::int16_t x, std::int16_t y) {
    return x >= 60 && x <= 300 && y >= 45 && y <= 305;
  }

  [[nodiscard]] bool headpat_ready(std::uint32_t now_ms) const {
    return !has_headpat_ || now_ms - last_headpat_ms_ >= kHeadpatDebounceMs;
  }

  Page page_{Page::Face};
  std::uint32_t last_headpat_ms_{0};
  bool has_headpat_{false};
};

}  // namespace psfn::satellite
