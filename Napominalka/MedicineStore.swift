import Foundation
import SwiftUI

/// Хранит лекарства, отметки о приёме и настройки. Сохраняет всё в файл на телефоне.
@MainActor
final class MedicineStore: ObservableObject {
    static let shared = MedicineStore()

    @Published private(set) var medicines: [Medicine] = []
    @Published private(set) var records: [DoseRecord] = []
    @Published var settings = AppSettings() {
        didSet {
            guard !isLoading, settings != oldValue else { return }
            save()
            let reminderChanged = settings.repeatEnabled != oldValue.repeatEnabled
                || settings.repeatInterval != oldValue.repeatInterval
                || settings.repeatCount != oldValue.repeatCount
            if reminderChanged { rescheduleNotifications() }
        }
    }

    private var isLoading = false
    private var scheduleTask: Task<Void, Never>?

    private let fileURL: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("napominalka.json")
    }()

    private init() {
        load()
    }

    // MARK: - Сохранение

    private func load() {
        isLoading = true
        defer { isLoading = false }
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder().decode(AppData.self, from: data) else { return }
        medicines = decoded.medicines
        records = decoded.records
        settings = decoded.settings
    }

    private func save() {
        // Храним историю за последние 120 дней.
        if let border = Calendar.current.date(byAdding: .day, value: -120, to: Date()) {
            let borderKey = DayKey.string(from: border)
            records.removeAll { $0.day < borderKey }
        }
        let data = AppData(medicines: medicines, records: records, settings: settings)
        do {
            let encoded = try JSONEncoder().encode(data)
            try encoded.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            print("Не удалось сохранить данные: \(error)")
        }
    }

    // MARK: - Лекарства

    func add(_ medicine: Medicine) {
        medicines.append(medicine)
        changed()
    }

    func update(_ medicine: Medicine) {
        guard let index = medicines.firstIndex(where: { $0.id == medicine.id }) else {
            add(medicine)
            return
        }
        medicines[index] = medicine
        changed()
    }

    func delete(_ medicine: Medicine) {
        medicines.removeAll { $0.id == medicine.id }
        changed()
    }

    func delete(at offsets: IndexSet) {
        medicines.remove(atOffsets: offsets)
        changed()
    }

    func move(from source: IndexSet, to destination: Int) {
        medicines.move(fromOffsets: source, toOffset: destination)
        save()
    }

    func medicine(id: UUID) -> Medicine? {
        medicines.first { $0.id == id }
    }

    // MARK: - Приёмы

    func record(medicineId: UUID, time: String, day: String) -> DoseRecord? {
        records.first { $0.medicineId == medicineId && $0.time == time && $0.day == day }
    }

    func markTaken(medicineId: UUID, time: String, day: String) {
        guard record(medicineId: medicineId, time: time, day: day) == nil else { return }
        let name = medicine(id: medicineId)?.name ?? ""
        records.append(DoseRecord(medicineId: medicineId, medicineName: name, day: day, time: time, takenAt: Date()))
        changed()
        NotificationManager.shared.doseHandled(medicineId: medicineId, time: time, day: day)
    }

    func unmarkTaken(medicineId: UUID, time: String, day: String) {
        records.removeAll { $0.medicineId == medicineId && $0.time == time && $0.day == day }
        changed()
    }

    func toggle(_ dose: Dose) {
        if dose.isTaken {
            unmarkTaken(medicineId: dose.medicine.id, time: dose.time.key, day: dose.day)
        } else {
            markTaken(medicineId: dose.medicine.id, time: dose.time.key, day: dose.day)
        }
    }

    /// Все приёмы в указанный день, отсортированные по времени.
    func doses(on date: Date) -> [Dose] {
        let day = DayKey.string(from: date)
        let startOfDay = Calendar.current.startOfDay(for: date)
        var result: [Dose] = []
        for med in medicines where med.isActive {
            // Не показываем дни до того, как лекарство было добавлено.
            if Calendar.current.startOfDay(for: med.createdAt) > startOfDay { continue }
            for time in med.sortedTimes {
                result.append(Dose(medicine: med, time: time, day: day,
                                   record: record(medicineId: med.id, time: time.key, day: day)))
            }
        }
        return result.sorted {
            if $0.time != $1.time { return $0.time < $1.time }
            return $0.medicine.name < $1.medicine.name
        }
    }

    var todayDoses: [Dose] { doses(on: Date()) }

    /// Ключи принятых доз ("id|день|время") — нужны для планирования напоминаний.
    var takenKeys: Set<String> {
        Set(records.map { "\($0.medicineId.uuidString)|\($0.day)|\($0.time)" })
    }

    // MARK: - Уведомления

    private func changed() {
        save()
        rescheduleNotifications()
    }

    /// Перепланирует все напоминания. Запуски идут строго по очереди, чтобы не мешать друг другу.
    func rescheduleNotifications() {
        let meds = medicines
        let taken = takenKeys
        let settings = settings
        let previous = scheduleTask
        scheduleTask = Task {
            await previous?.value
            await NotificationManager.shared.reschedule(medicines: meds, takenKeys: taken, settings: settings)
        }
    }

    /// Дождаться, пока напоминания будут перепланированы.
    func waitForScheduling() async {
        await scheduleTask?.value
    }
}
