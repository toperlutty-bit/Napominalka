import Foundation
import UIKit
import UserNotifications

/// Отвечает за все уведомления: планирует напоминания и обрабатывает нажатия на кнопки в них.
final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationManager()

    static let categoryId = "DOSE_REMINDER"
    static let takenActionId = "TAKEN"
    static let snoozeActionId = "SNOOZE"

    /// На сколько минут откладывает кнопка «Напомнить позже».
    static let snoozeMinutes = 10

    /// iOS хранит не больше 64 запланированных уведомлений. Оставляем запас для «Напомнить позже».
    private static let maxScheduled = 58

    private let center = UNUserNotificationCenter.current()

    // MARK: - Настройка

    func configure() {
        center.delegate = self

        let taken = UNNotificationAction(identifier: Self.takenActionId,
                                         title: "✅ Выпила",
                                         options: [])
        let snooze = UNNotificationAction(identifier: Self.snoozeActionId,
                                          title: "⏰ Напомнить через \(Self.snoozeMinutes) минут",
                                          options: [])
        let category = UNNotificationCategory(identifier: Self.categoryId,
                                              actions: [taken, snooze],
                                              intentIdentifiers: [],
                                              options: [])
        center.setNotificationCategories([category])
    }

    @discardableResult
    func requestAuthorization() async -> Bool {
        (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    // MARK: - Планирование

    /// Удаляет старые напоминания и создаёт новые по текущему расписанию.
    ///
    /// * Основное напоминание повторяется каждый день в назначенное время — оно сработает,
    ///   даже если приложение долго не открывали.
    /// * Повторные напоминания («Вы ещё не отметили…») создаются на ближайшие дни
    ///   только для тех приёмов, которые ещё не отмечены.
    func reschedule(medicines: [Medicine], takenKeys: Set<String>, settings: AppSettings) async {
        let pending = await center.pendingNotificationRequests()
        let oldIds = pending.map(\.identifier).filter { $0.hasPrefix("main|") || $0.hasPrefix("follow|") }
        center.removePendingNotificationRequests(withIdentifiers: oldIds)

        let active = medicines.filter { $0.isActive && !$0.times.isEmpty }
        var requests: [UNNotificationRequest] = []

        // 1. Ежедневные основные напоминания.
        for med in active {
            for time in Set(med.times).sorted() {
                guard requests.count < Self.maxScheduled else { break }
                let content = makeContent(
                    title: "💊 Пора принять лекарство",
                    body: bodyText(for: med, time: time),
                    medicine: med, time: time, day: nil)
                var comps = DateComponents()
                comps.hour = time.hour
                comps.minute = time.minute
                let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: true)
                requests.append(UNNotificationRequest(
                    identifier: "main|\(med.id.uuidString)|\(time.key)",
                    content: content, trigger: trigger))
            }
        }

        // 2. Повторные напоминания, если приём не отмечен.
        if settings.repeatEnabled && settings.repeatCount > 0 {
            let calendar = Calendar.current
            let now = Date()
            let today = calendar.startOfDay(for: now)
            dayLoop: for dayOffset in 0..<7 {
                guard let day = calendar.date(byAdding: .day, value: dayOffset, to: today) else { continue }
                let dayKey = DayKey.string(from: day)
                for med in active {
                    for time in Set(med.times).sorted() {
                        if takenKeys.contains("\(med.id.uuidString)|\(dayKey)|\(time.key)") { continue }
                        for n in 1...settings.repeatCount {
                            if requests.count >= Self.maxScheduled { break dayLoop }
                            let fireDate = time.date(on: day).addingTimeInterval(TimeInterval(n * settings.repeatInterval * 60))
                            guard fireDate > now else { continue }
                            let content = makeContent(
                                title: "⏰ Напоминаю: \(med.name)",
                                body: "Приём в \(time.key) ещё не отмечен. \(bodyText(for: med, time: time))",
                                medicine: med, time: time, day: dayKey)
                            let comps = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: fireDate)
                            let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
                            requests.append(UNNotificationRequest(
                                identifier: "follow|\(med.id.uuidString)|\(dayKey)|\(time.key)|\(n)",
                                content: content, trigger: trigger))
                        }
                    }
                }
            }
        }

        for request in requests {
            do {
                try await center.add(request)
            } catch {
                print("Не удалось запланировать уведомление: \(error)")
            }
        }
    }

    private func bodyText(for med: Medicine, time: DoseTime) -> String {
        var parts: [String] = [med.name]
        if !med.dosage.isEmpty { parts[0] += " — \(med.dosage)" }
        if !med.note.isEmpty { parts.append(med.note) }
        return parts.joined(separator: ". ")
    }

    private func makeContent(title: String, body: String, medicine: Medicine, time: DoseTime, day: String?) -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.categoryIdentifier = Self.categoryId
        content.threadIdentifier = medicine.id.uuidString
        var info: [String: String] = [
            "medicineId": medicine.id.uuidString,
            "time": time.key,
        ]
        if let day { info["day"] = day }
        content.userInfo = info
        return content
    }

    /// Пробное уведомление — чтобы убедиться, что всё работает.
    func sendTestNotification() {
        let content = UNMutableNotificationContent()
        content.title = "💊 Проверка напоминаний"
        content.body = "Всё работает! Так будут выглядеть напоминания о лекарствах."
        content.sound = .default
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false)
        center.add(UNNotificationRequest(identifier: "test|\(UUID().uuidString)", content: content, trigger: trigger))
    }

    /// «Напомнить через 10 минут».
    private func scheduleSnooze(of content: UNNotificationContent, day: String) {
        guard let copy = content.mutableCopy() as? UNMutableNotificationContent else { return }
        var info = content.userInfo
        info["day"] = day
        copy.userInfo = info
        let medId = info["medicineId"] as? String ?? ""
        let time = info["time"] as? String ?? ""
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: TimeInterval(Self.snoozeMinutes * 60), repeats: false)
        center.add(UNNotificationRequest(
            identifier: "snooze|\(medId)|\(day)|\(time)|\(Int(Date().timeIntervalSince1970))",
            content: copy, trigger: trigger))
    }

    /// Приём отмечен: убираем показанные уведомления о нём и отложенные напоминания.
    func doseHandled(medicineId: UUID, time: String, day: String) {
        let medId = medicineId.uuidString
        center.getDeliveredNotifications { [center] delivered in
            let ids = delivered
                .filter {
                    let info = $0.request.content.userInfo
                    return info["medicineId"] as? String == medId && info["time"] as? String == time
                }
                .map(\.request.identifier)
            center.removeDeliveredNotifications(withIdentifiers: ids)
        }
        center.getPendingNotificationRequests { [center] pending in
            let prefix = "snooze|\(medId)|\(day)|\(time)|"
            let ids = pending.map(\.identifier).filter { $0.hasPrefix(prefix) }
            center.removePendingNotificationRequests(withIdentifiers: ids)
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Показывать уведомление, даже когда приложение открыто.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    /// Нажатие на уведомление или на кнопку в нём.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let content = response.notification.request.content
        let info = content.userInfo
        guard let idString = info["medicineId"] as? String,
              let medicineId = UUID(uuidString: idString),
              let time = info["time"] as? String else {
            completionHandler()
            return
        }
        let day = (info["day"] as? String) ?? DayKey.string(from: response.notification.date)

        switch response.actionIdentifier {
        case Self.takenActionId:
            Task { @MainActor in
                MedicineStore.shared.markTaken(medicineId: medicineId, time: time, day: day)
                await MedicineStore.shared.waitForScheduling()
                completionHandler()
            }
        case Self.snoozeActionId:
            scheduleSnooze(of: content, day: day)
            completionHandler()
        default:
            completionHandler()
        }
    }
}
