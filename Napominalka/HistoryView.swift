import SwiftUI

/// История приёмов за последние две недели.
struct HistoryView: View {
    @EnvironmentObject private var store: MedicineStore

    private let daysToShow = 14

    private var days: [Date] {
        let today = Calendar.current.startOfDay(for: Date())
        return (0..<daysToShow).compactMap { Calendar.current.date(byAdding: .day, value: -$0, to: today) }
    }

    var body: some View {
        NavigationStack {
            List {
                weekSummary
                ForEach(days, id: \.self) { day in
                    let doses = store.doses(on: day)
                    if !doses.isEmpty {
                        Section {
                            ForEach(doses) { dose in
                                HistoryRow(dose: dose)
                                    .swipeActions {
                                        Button {
                                            store.toggle(dose)
                                        } label: {
                                            if dose.isTaken {
                                                Label("Не принято", systemImage: "xmark")
                                            } else {
                                                Label("Принято", systemImage: "checkmark")
                                            }
                                        }
                                        .tint(dose.isTaken ? .gray : .green)
                                    }
                            }
                        } header: {
                            Text(dayTitle(day))
                                .font(.headline)
                        }
                    }
                }
            }
            .navigationTitle("История")
        }
    }

    @ViewBuilder
    private var weekSummary: some View {
        let now = Date()
        let lastWeek = days.prefix(7).flatMap { store.doses(on: $0) }
            .filter { $0.time.date(on: DayKey.date(from: $0.day) ?? now) <= now }
        if !lastWeek.isEmpty {
            let taken = lastWeek.filter(\.isTaken).count
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("За 7 дней")
                        .font(.headline)
                        .foregroundStyle(.secondary)
                    Text("Принято \(taken) из \(lastWeek.count)")
                        .font(.title2.bold())
                    if taken < lastWeek.count {
                        Text("Пропущено: \(lastWeek.count - taken)")
                            .font(.title3)
                            .foregroundStyle(.red)
                    }
                }
                .padding(.vertical, 6)
            } footer: {
                Text("Проведите по строке влево, чтобы изменить отметку.")
            }
        }
    }

    private func dayTitle(_ day: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(day) { return "Сегодня" }
        if calendar.isDateInYesterday(day) { return "Вчера" }
        return Theme.longDate(day)
    }
}

struct HistoryRow: View {
    let dose: Dose

    private enum Status { case taken, missed, waiting }

    private var status: Status {
        if dose.isTaken { return .taken }
        let day = DayKey.date(from: dose.day) ?? Date()
        return dose.time.date(on: day) <= Date() ? .missed : .waiting
    }

    var body: some View {
        HStack(spacing: 12) {
            Text(dose.time.key)
                .font(.title3.monospacedDigit().bold())
                .frame(minWidth: 64, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(dose.medicine.name)
                    .font(.title3)
                switch status {
                case .taken:
                    Text("Выпито в \(Theme.shortTime(dose.record?.takenAt ?? Date()))")
                        .font(.callout)
                        .foregroundStyle(.green)
                case .missed:
                    Text("Не отмечено")
                        .font(.callout)
                        .foregroundStyle(.red)
                case .waiting:
                    Text("Ещё не время")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            switch status {
            case .taken:
                Image(systemName: "checkmark.circle.fill").font(.title).foregroundStyle(.green)
            case .missed:
                Image(systemName: "xmark.circle.fill").font(.title).foregroundStyle(.red)
            case .waiting:
                Image(systemName: "clock").font(.title).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}
