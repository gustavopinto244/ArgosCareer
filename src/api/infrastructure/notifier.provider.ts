import { FactoryProvider } from "@nestjs/common";
import { NotifierPort } from "../../delivery/domain/ports/notifier.port";
import { loadTelegramConfig } from "../../delivery/infrastructure/telegram-config";
import {
  TelegramNotifier,
  TextNotifier,
} from "../../delivery/infrastructure/telegram-notifier";

/**
 * `POST /runs/deliver` (M9) needs a real `NotifierPort` in production and a
 * fake one in tests — a `new TelegramNotifier(...)` constructed inline in
 * the handler would make every test of that endpoint a real network call to
 * Telegram, which is exactly what `docs/07-testing-strategy.md`'s "no real
 * network call" rule exists to prevent. Overridden with
 * `.overrideProvider(NOTIFIER)` in `runs.controller.test.ts`.
 *
 * Typed `NotifierPort & TextNotifier` (M10): `MarketService.studyPlan`
 * needs `sendText`, `RunsService.deliver` needs `notify` — both read the
 * same one `TelegramNotifier` instance this factory already builds, not a
 * second provider standing up a second client.
 */
export const NOTIFIER = Symbol("NOTIFIER");

export const notifierProvider: FactoryProvider<NotifierPort & TextNotifier> = {
  provide: NOTIFIER,
  useFactory: (): NotifierPort & TextNotifier =>
    new TelegramNotifier(loadTelegramConfig()),
};
