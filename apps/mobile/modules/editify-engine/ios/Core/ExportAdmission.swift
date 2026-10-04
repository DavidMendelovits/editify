import Foundation

/// Whether an export runs inside a background task or in the foreground (OV5, decision D24's
/// "BG admission when the entitlement is present"). The decision half of ExportCenter.admit,
/// against the BackgroundExecution port only, so a stub scheduler can test it:
///
///   supportsBackgroundGPU? (entitlement present and the phone reports .gpu)
///     ├─ no ──────────────────────────────────────────────▶ foreground(notice)
///     └─ yes ─ register(identifier) once ─ refused ────────▶ foreground(notice)
///                └─ ok ─ prepare() ─ submit ─ throws ─ revert() ▶ foreground(notice)
///                                     └─ ok ──────────────▶ background(identifier)
///
/// The legacy (iOS 18) set's ForegroundExecution answers no to the first question, so every
/// export there takes the foreground path: the notice, the screen kept awake, stopped with a
/// reason if Editify goes to the background.
public enum ExportAdmission: Equatable, Sendable {
  case background(identifier: String)
  case foreground(notice: String)

  public static let foregroundNotice = "Keep Editify open until the export finishes."

  /// `fresh`: false when `identifier` was already registered (iOS kills an app that registers
  /// one twice). `prepare` runs before submitting (the launch handler can run before submit
  /// returns); `revert` undoes it when the submit is refused.
  public static func decide(_ background: any BackgroundExecution, identifier: String, fresh: Bool,
                            launched: @escaping @Sendable (any BackgroundTask) -> Void,
                            prepare: () -> Void, revert: () -> Void) -> ExportAdmission {
    guard background.supportsBackgroundGPU else { return .foreground(notice: foregroundNotice) }
    guard fresh, background.register(identifier, launched: launched) else { return .foreground(notice: foregroundNotice) }
    prepare()
    do {
      try background.submit(identifier, title: "Exporting video", subtitle: "Starting")
    } catch {
      // Includes "not permitted" when the entitlement is missing from the signed build.
      revert()
      return .foreground(notice: foregroundNotice)
    }
    return .background(identifier: identifier)
  }
}
