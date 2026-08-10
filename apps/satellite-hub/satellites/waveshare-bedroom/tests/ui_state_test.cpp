#include <cassert>
#include <cstdint>

#include "../esphome/includes/ui_state.h"

using psfn::satellite::Gesture;
using psfn::satellite::InteractionAction;
using psfn::satellite::Page;
using psfn::satellite::UiState;

int main() {
  UiState state;
  assert(state.page() == Page::Face);

  auto result = state.handle(Gesture::SwipeLeft, 0, 0, 100);
  assert(result.page == Page::Devices);
  assert(result.page_changed);
  assert(result.action == InteractionAction::None);

  result = state.handle(Gesture::SwipeLeft, 0, 0, 200);
  assert(result.page == Page::Settings);
  result = state.handle(Gesture::SwipeLeft, 0, 0, 300);
  assert(result.page == Page::Face);
  result = state.handle(Gesture::SwipeRight, 0, 0, 400);
  assert(result.page == Page::Settings);
  result = state.handle(Gesture::SwipeRight, 0, 0, 500);
  assert(result.page == Page::Devices);
  result = state.handle(Gesture::SwipeRight, 0, 0, 600);
  assert(result.page == Page::Face);

  result = state.handle(Gesture::Tap, 180, 170, 1'000);
  assert(result.action == InteractionAction::Headpat);
  assert(!result.page_changed);

  result = state.handle(Gesture::Tap, 180, 170, 1'500);
  assert(result.action == InteractionAction::None);

  result = state.handle(Gesture::Tap, 180, 170, 3'999);
  assert(result.action == InteractionAction::None);

  result = state.handle(Gesture::Tap, 180, 170, 4'000);
  assert(result.action == InteractionAction::Headpat);

  result = state.handle(Gesture::Tap, 20, 20, 4'500);
  assert(result.action == InteractionAction::None);

  state.handle(Gesture::SwipeLeft, 0, 0, 5'000);
  result = state.handle(Gesture::Tap, 180, 170, 6'000);
  assert(result.page == Page::Devices);
  assert(result.action == InteractionAction::None);
}
