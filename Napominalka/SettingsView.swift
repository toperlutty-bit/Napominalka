import SwiftUI
import UIKit
import UserNotifications

struct SettingsView: View {
    @EnvironmentObject private var store: MedicineStore
    @State private var status: UNAuthorizationStatus = .notDetermined
    @State private var testSent = false

    private let intervals = [5, 10, 15, 20, 30, 60]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Например, мама", text: $store.settings.name)
                        .font(.title3)
                } header: {
                    Text("Как обращаться")
                } footer: {
                    Text("Используется в приветствии на экране «Сегодня».")
                }

                Section {
                    Toggle("Повторять, если не отмечено", isOn: $store.settings.repeatEnabled)
                    if store.settings.repeatEnabled {
                        Picker("Через сколько минут", selection: $store.settings.repeatInterval) {
                            ForEach(intervals, id: \.self) { Text("\($0) мин").tag($0) }
                        }
                        Stepper("Сколько раз: \(store.settings.repeatCount)",
                                value: $store.settings.repeatCount, in: 1...5)
                    }
                } header: {
                    Text("Повторные напоминания")
                } footer: {
                    Text("Если не нажать «Выпила», телефон напомнит ещё раз. Как только приём отмечен — повторы отменяются.")
                }

                Section {
                    HStack {
                        Text("Уведомления")
                        Spacer()
                        Text(statusText)
                            .foregroundStyle(status == .denied ? Color.red : Color.secondary)
                    }
                    if status == .denied {
                        Button("Открыть настройки iPhone") {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        }
                    } else if status == .notDetermined {
                        Button("Разрешить уведомления") {
                            Task {
                                await NotificationManager.shared.requestAuthorization()
                                await refresh()
                                store.rescheduleNotifications()
                            }
                        }
                    }
                    Button {
                        NotificationManager.shared.sendTestNotification()
                        testSent = true
                    } label: {
                        Label("Проверить: прислать уведомление", systemImage: "bell.badge")
                    }
                    if testSent {
                        Text("Уведомление придёт через 5 секунд. Можно свернуть приложение.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Уведомления")
                }

                Section("Советы") {
                    tip("speaker.wave.3.fill", "Проверьте, что звук на телефоне включён и переключатель сбоку не в беззвучном режиме.")
                    tip("moon.fill", "В режиме «Не беспокоить» напоминания приходят без звука. Добавьте приложение в исключения в Настройках → Фокусирование.")
                    tip("checkmark.circle.fill", "Нажмите «Выпила» прямо в уведомлении (удерживайте его пальцем) — открывать приложение не обязательно.")
                }
            }
            .font(.body)
            .navigationTitle("Настройки")
            .task { await refresh() }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
                Task { await refresh() }
            }
        }
    }

    private var statusText: String {
        switch status {
        case .authorized, .provisional, .ephemeral: return "Включены"
        case .denied: return "Выключены"
        default: return "Не настроены"
        }
    }

    private func refresh() async {
        let s = await NotificationManager.shared.authorizationStatus()
        await MainActor.run { status = s }
    }

    private func tip(_ icon: String, _ text: String) -> some View {
        Label {
            Text(text)
        } icon: {
            Image(systemName: icon).foregroundStyle(.blue)
        }
        .padding(.vertical, 2)
    }
}
