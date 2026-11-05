import SwiftUI

struct MedicinesView: View {
    @EnvironmentObject private var store: MedicineStore
    @State private var editing: Medicine?
    @State private var showingAdd = false

    var body: some View {
        NavigationStack {
            List {
                if store.medicines.isEmpty {
                    Text("Нажмите «Добавить», чтобы добавить первое лекарство.")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                        .padding(.vertical)
                }
                ForEach(store.medicines) { med in
                    Button {
                        editing = med
                    } label: {
                        MedicineRow(medicine: med)
                    }
                    .buttonStyle(.plain)
                }
                .onDelete { store.delete(at: $0) }
                .onMove { store.move(from: $0, to: $1) }
            }
            .navigationTitle("Лекарства")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    if !store.medicines.isEmpty { EditButton() }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showingAdd = true
                    } label: {
                        Label("Добавить", systemImage: "plus.circle.fill")
                            .font(.title2)
                    }
                }
            }
            .sheet(isPresented: $showingAdd) {
                EditMedicineView(medicine: nil)
            }
            .sheet(item: $editing) { med in
                EditMedicineView(medicine: med)
            }
        }
    }
}

struct MedicineRow: View {
    let medicine: Medicine

    var body: some View {
        HStack(spacing: 14) {
            PillIcon(colorIndex: medicine.colorIndex)
            VStack(alignment: .leading, spacing: 4) {
                Text(medicine.name)
                    .font(.title3.bold())
                Text(medicine.sortedTimes.map(\.key).joined(separator: ", "))
                    .font(.title3.monospacedDigit())
                    .foregroundStyle(.blue)
                if !medicine.dosage.isEmpty || !medicine.note.isEmpty {
                    Text([medicine.dosage, medicine.note].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
                if !medicine.isActive {
                    Label("Напоминания выключены", systemImage: "bell.slash")
                        .font(.callout)
                        .foregroundStyle(.orange)
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .opacity(medicine.isActive ? 1 : 0.6)
    }
}
