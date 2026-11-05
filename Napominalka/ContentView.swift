import SwiftUI
import UIKit
import UserNotifications

struct ContentView: View {
    @EnvironmentObject private var store: MedicineStore

    var body: some View {
        TabView {
            TodayView()
                .tabItem { Label("Сегодня", systemImage: "sun.max.fill") }
            MedicinesView()
                .tabItem { Label("Лекарства", systemImage: "pills.fill") }
            HistoryView()
                .tabItem { Label("История", systemImage: "calendar") }
            SettingsView()
                .tabItem { Label("Настройки", systemImage: "gearshape.fill") }
        }
        .task {
            if await NotificationManager.shared.authorizationStatus() == .notDetermined {
                await NotificationManager.shared.requestAuthorization()
            }
            store.rescheduleNotifications()
        }
    }
}

/// Предупреждение, если уведомления запрещены — без них напоминания не придут.
struct NotificationWarning: View {
    @State private var status: UNAuthorizationStatusWrapper = .unknown

    var body: some View {
        Group {
            switch status {
            case .denied:
                card(text: "Уведомления выключены — напоминания не будут приходить.",
                     button: "Включить в настройках") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
            case .notDetermined:
                card(text: "Разрешите уведомления, чтобы получать напоминания о лекарствах.",
                     button: "Разрешить уведомления") {
                    Task {
                        await NotificationManager.shared.requestAuthorization()
                        await refresh()
                        await MainActor.run { MedicineStore.shared.rescheduleNotifications() }
                    }
                }
            case .ok, .unknown:
                EmptyView()
            }
        }
        .task { await refresh() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            Task { await refresh() }
        }
    }

    private func refresh() async {
        let s = await NotificationManager.shared.authorizationStatus()
        let wrapped: UNAuthorizationStatusWrapper
        switch s {
        case .denied: wrapped = .denied
        case .notDetermined: wrapped = .notDetermined
        default: wrapped = .ok
        }
        await MainActor.run { status = wrapped }
    }

    private func card(text: String, button: String, action: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(text, systemImage: "bell.slash.fill")
                .font(.title3.weight(.semibold))
                .foregroundStyle(.white)
            Button(action: action) {
                Text(button)
                    .font(.title3.bold())
                    .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.borderedProminent)
            .tint(.white)
            .foregroundStyle(.red)
        }
        .padding()
        .background(RoundedRectangle(cornerRadius: 20).fill(Color.red))
    }
}

enum UNAuthorizationStatusWrapper {
    case unknown, ok, denied, notDetermined
}
