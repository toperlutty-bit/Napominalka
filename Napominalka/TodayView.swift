import SwiftUI
import UIKit

struct TodayView: View {
    @EnvironmentObject private var store: MedicineStore
    @State private var now = Date()
    @State private var showingAdd = false

    private let timer = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    private var doses: [Dose] { store.doses(on: now) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    NotificationWarning()
                    if store.medicines.isEmpty {
                        emptyState
                    } else if doses.isEmpty {
                        Text("На сегодня лекарств нет.")
                            .font(.title2)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 40)
                    } else {
                        progress
                        ForEach(doses) { dose in
                            DoseCard(dose: dose, now: now)
                        }
                    }
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .toolbar(.hidden, for: .navigationBar)
            .onReceive(timer) { now = $0 }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
                now = Date()
            }
            .sheet(isPresented: $showingAdd) {
                EditMedicineView(medicine: nil)
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(Theme.greeting(for: now, name: store.settings.name))
                .font(.title2)
                .foregroundStyle(.secondary)
            Text(Theme.longDate(now))
                .font(.largeTitle.bold())
        }
        .padding(.top, 8)
    }

    private var progress: some View {
        let taken = doses.filter(\.isTaken).count
        let total = doses.count
        let allDone = taken == total
        return VStack(alignment: .leading, spacing: 10) {
            Text(allDone ? "Все лекарства на сегодня приняты 🎉" : "Принято \(taken) из \(total)")
                .font(.title2.bold())
                .foregroundStyle(allDone ? Color.green : Color.primary)
            ProgressView(value: Double(taken), total: Double(max(total, 1)))
                .tint(.green)
                .scaleEffect(x: 1, y: 2.5, anchor: .center)
                .padding(.vertical, 6)
        }
        .padding()
        .background(RoundedRectangle(cornerRadius: 20).fill(Color(.secondarySystemGroupedBackground)))
    }

    private var emptyState: some View {
        VStack(spacing: 20) {
            Image(systemName: "pills.circle.fill")
                .font(.system(size: 90))
                .foregroundStyle(.blue)
            Text("Пока нет лекарств")
                .font(.title.bold())
            Text("Добавьте лекарство и время приёма — телефон будет напоминать.")
                .font(.title3)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button {
                showingAdd = true
            } label: {
                Label("Добавить лекарство", systemImage: "plus")
                    .font(.title2.bold())
                    .frame(maxWidth: .infinity, minHeight: 64)
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 30)
    }
}

/// Карточка одного приёма: время, лекарство и большая кнопка «Выпила».
struct DoseCard: View {
    @EnvironmentObject private var store: MedicineStore
    let dose: Dose
    let now: Date

    @State private var confirmUndo = false

    private var isDue: Bool {
        !dose.isTaken && dose.time.date(on: now) <= now && dose.day == DayKey.string(from: now)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                PillIcon(colorIndex: dose.medicine.colorIndex, size: 60)
                VStack(alignment: .leading, spacing: 4) {
                    Text(dose.time.key)
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                        .foregroundStyle(isDue ? Color.orange : Color.primary)
                    Text(dose.medicine.name)
                        .font(.title2.bold())
                    if !dose.medicine.dosage.isEmpty {
                        Text(dose.medicine.dosage)
                            .font(.title3)
                    }
                    if !dose.medicine.note.isEmpty {
                        Text(dose.medicine.note)
                            .font(.title3)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }

            if let record = dose.record {
                HStack {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title)
                    Text("Выпито в \(Theme.shortTime(record.takenAt))")
                        .font(.title3.bold())
                    Spacer()
                    Button("Отменить") { confirmUndo = true }
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
                .foregroundStyle(.green)
            } else {
                if isDue {
                    Label("Пора принять!", systemImage: "bell.fill")
                        .font(.title3.bold())
                        .foregroundStyle(.orange)
                }
                Button {
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    withAnimation { store.toggle(dose) }
                } label: {
                    Label("Выпила", systemImage: "checkmark")
                        .font(.title.bold())
                        .frame(maxWidth: .infinity, minHeight: 64)
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)
            }
        }
        .padding()
        .background(
            RoundedRectangle(cornerRadius: 22)
                .fill(dose.isTaken ? Color.green.opacity(0.10) : Color(.secondarySystemGroupedBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22)
                .stroke(isDue ? Color.orange : Color.clear, lineWidth: 3)
        )
        .confirmationDialog("Отменить отметку о приёме?", isPresented: $confirmUndo, titleVisibility: .visible) {
            Button("Да, я ещё не пила", role: .destructive) {
                withAnimation { store.toggle(dose) }
            }
            Button("Нет", role: .cancel) {}
        }
    }
}
