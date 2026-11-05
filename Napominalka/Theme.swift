import SwiftUI

enum Theme {
    static let colors: [Color] = [.blue, .green, .orange, .pink, .purple, .teal, .red, .indigo]

    static func color(_ index: Int) -> Color {
        let count = colors.count
        return colors[((index % count) + count) % count]
    }

    private static let ruLocale = Locale(identifier: "ru_RU")

    /// «Четверг, 5 ноября»
    static func longDate(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = ruLocale
        f.dateFormat = "EEEE, d MMMM"
        let s = f.string(from: date)
        return s.prefix(1).uppercased() + s.dropFirst()
    }

    /// «08:15»
    static func shortTime(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = ruLocale
        f.dateFormat = "HH:mm"
        return f.string(from: date)
    }

    static func greeting(for date: Date, name: String) -> String {
        let hour = Calendar.current.component(.hour, from: date)
        let base: String
        switch hour {
        case 5..<12: base = "Доброе утро"
        case 12..<18: base = "Добрый день"
        case 18..<23: base = "Добрый вечер"
        default: base = "Доброй ночи"
        }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "\(base)!" : "\(base), \(trimmed)!"
    }
}

/// Цветной кружок с таблеткой.
struct PillIcon: View {
    let colorIndex: Int
    var size: CGFloat = 52

    var body: some View {
        ZStack {
            Circle().fill(Theme.color(colorIndex).opacity(0.18))
            Image(systemName: "pills.fill")
                .font(.system(size: size * 0.45, weight: .semibold))
                .foregroundStyle(Theme.color(colorIndex))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Горизонтальный ряд кнопок-подсказок для быстрого заполнения поля.
struct SuggestionChips: View {
    let options: [String]
    let onSelect: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(options, id: \.self) { option in
                    Button(option) { onSelect(option) }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                }
            }
            .padding(.vertical, 2)
        }
    }
}
