import Foundation

/// Время приёма (часы и минуты), например 08:00.
struct DoseTime: Codable, Hashable, Identifiable, Comparable {
    var hour: Int
    var minute: Int

    var id: String { key }

    /// Строка вида "08:30" — используется как ключ и для отображения.
    var key: String { String(format: "%02d:%02d", hour, minute) }

    var minutesOfDay: Int { hour * 60 + minute }

    static func < (lhs: DoseTime, rhs: DoseTime) -> Bool {
        lhs.minutesOfDay < rhs.minutesOfDay
    }

    init(hour: Int, minute: Int) {
        self.hour = hour
        self.minute = minute
    }

    init(date: Date) {
        let comps = Calendar.current.dateComponents([.hour, .minute], from: date)
        self.hour = comps.hour ?? 8
        self.minute = comps.minute ?? 0
    }

    init?(key: String) {
        let parts = key.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return nil }
        self.hour = parts[0]
        self.minute = parts[1]
    }

    /// Дата с этим временем в указанный день.
    func date(on day: Date) -> Date {
        Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: day) ?? day
    }
}

/// Лекарство и расписание его приёма.
struct Medicine: Codable, Identifiable, Hashable {
    var id: UUID = UUID()
    var name: String
    var dosage: String = "1 таблетка"
    var note: String = ""
    var times: [DoseTime] = [DoseTime(hour: 9, minute: 0)]
    var colorIndex: Int = 0
    var isActive: Bool = true
    var createdAt: Date = Date()

    var sortedTimes: [DoseTime] { times.sorted() }
}

/// Отметка о том, что лекарство принято.
struct DoseRecord: Codable, Identifiable, Hashable {
    var id: UUID = UUID()
    var medicineId: UUID
    var medicineName: String
    /// День приёма в формате "yyyy-MM-dd".
    var day: String
    /// Запланированное время "HH:mm".
    var time: String
    var takenAt: Date
}

/// Настройки приложения.
struct AppSettings: Codable, Hashable {
    /// Имя для приветствия на главном экране (например, «мама»).
    var name: String = ""
    /// Повторять напоминание, если приём не отмечен.
    var repeatEnabled: Bool = true
    /// Через сколько минут повторять.
    var repeatInterval: Int = 15
    /// Сколько раз повторять.
    var repeatCount: Int = 2
}

/// Конкретный приём лекарства в конкретный день (для экрана «Сегодня» и истории).
struct Dose: Identifiable, Hashable {
    let medicine: Medicine
    let time: DoseTime
    let day: String
    let record: DoseRecord?

    var id: String { "\(medicine.id.uuidString)|\(day)|\(time.key)" }
    var isTaken: Bool { record != nil }
}

/// Всё, что сохраняется на устройстве.
struct AppData: Codable {
    var medicines: [Medicine] = []
    var records: [DoseRecord] = []
    var settings: AppSettings = AppSettings()
}

enum DayKey {
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func string(from date: Date) -> String {
        formatter.timeZone = TimeZone.current
        return formatter.string(from: date)
    }

    static func date(from key: String) -> Date? {
        formatter.timeZone = TimeZone.current
        return formatter.date(from: key)
    }

    static var today: String { string(from: Date()) }
}
