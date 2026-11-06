import SwiftUI

/// Экран добавления и редактирования лекарства.
struct EditMedicineView: View {
    @EnvironmentObject private var store: MedicineStore
    @Environment(\.dismiss) private var dismiss

    private struct EditableTime: Identifiable {
        let id = UUID()
        var date: Date
    }

    @State private var draft: Medicine
    @State private var times: [EditableTime]
    @State private var confirmDelete = false
    private let isNew: Bool

    private let dosageOptions = ["1 таблетка", "2 таблетки", "½ таблетки", "1 капсула", "10 капель", "1 ложка"]
    private let noteOptions = ["до еды", "после еды", "во время еды", "натощак", "перед сном", "запить водой"]

    init(medicine: Medicine?) {
        let med = medicine ?? Medicine(name: "", colorIndex: Int.random(in: 0..<Theme.colors.count))
        _draft = State(initialValue: med)
        _times = State(initialValue: med.sortedTimes.map { EditableTime(date: $0.date(on: Date())) })
        isNew = medicine == nil
    }

    private var canSave: Bool {
        !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !times.isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Название") {
                    TextField("Например, Аспирин", text: $draft.name)
                        .font(.title3)
                        .textInputAutocapitalization(.sentences)
                }

                Section("Сколько принимать") {
                    TextField("Например, 1 таблетка", text: $draft.dosage)
                        .font(.title3)
                    SuggestionChips(options: dosageOptions) { draft.dosage = $0 }
                }

                Section {
                    ForEach($times) { $time in
                        HStack {
                            DatePicker("Приём", selection: $time.date, displayedComponents: .hourAndMinute)
                                .font(.title3)
                            Button(role: .destructive) {
                                times.removeAll { $0.id == time.id }
                            } label: {
                                Image(systemName: "minus.circle.fill")
                                    .font(.title2)
                                    .foregroundStyle(.red)
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Удалить это время")
                        }
                    }
                    Button {
                        addTime()
                    } label: {
                        Label("Добавить время приёма", systemImage: "plus.circle.fill")
                            .font(.title3)
                    }
                } header: {
                    Text("Когда принимать")
                } footer: {
                    Text("Каждый день в это время придёт напоминание.")
                }

                Section("Примечание") {
                    TextField("Например, после еды", text: $draft.note)
                        .font(.title3)
                    SuggestionChips(options: noteOptions) { draft.note = $0 }
                }

                Section("Цвет") {
                    HStack(spacing: 10) {
                        ForEach(Theme.colors.indices, id: \.self) { index in
                            Circle()
                                .fill(Theme.color(index))
                                .frame(width: 34, height: 34)
                                .overlay(
                                    Circle().stroke(Color.primary, lineWidth: draft.colorIndex == index ? 3 : 0)
                                        .padding(-4)
                                )
                                .onTapGesture { draft.colorIndex = index }
                        }
                    }
                    .padding(.vertical, 6)
                }

                Section {
                    Toggle("Напоминать", isOn: $draft.isActive)
                        .font(.title3)
                }

                if !isNew {
                    Section {
                        Button("Удалить лекарство", role: .destructive) {
                            confirmDelete = true
                        }
                        .font(.title3)
                    }
                }
            }
            .navigationTitle(isNew ? "Новое лекарство" : "Лекарство")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Сохранить") { save() }
                        .bold()
                        .disabled(!canSave)
                }
            }
            .confirmationDialog("Удалить «\(draft.name)»?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Удалить", role: .destructive) {
                    store.delete(draft)
                    dismiss()
                }
                Button("Отмена", role: .cancel) {}
            }
        }
    }

    private func addTime() {
        let calendar = Calendar.current
        let next: Date
        if let last = times.map(\.date).max() {
            next = calendar.date(byAdding: .hour, value: 4, to: last) ?? last
        } else {
            next = DoseTime(hour: 9, minute: 0).date(on: Date())
        }
        times.append(EditableTime(date: next))
    }

    private func save() {
        var med = draft
        med.name = med.name.trimmingCharacters(in: .whitespacesAndNewlines)
        med.dosage = med.dosage.trimmingCharacters(in: .whitespacesAndNewlines)
        med.note = med.note.trimmingCharacters(in: .whitespacesAndNewlines)
        med.times = Array(Set(times.map { DoseTime(date: $0.date) })).sorted()
        if isNew {
            store.add(med)
        } else {
            store.update(med)
        }
        dismiss()
    }
}
