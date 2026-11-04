import SwiftUI
import WidgetKit

// Centel's Home Screen and Lock Screen widgets. They show the snapshot the app last saved
// in the App Group (App/WidgetData.swift, written by widget.js on the page): this month's
// spending, the next unpaid bills and the open to-dos. Tapping opens the app on that part.

// MARK: - Snapshot

struct Snapshot: Decodable {
    struct Bill: Decodable, Identifiable {
        let id: String
        let name: String
        let amount: Double
        let needsAmount: Bool
        let autopay: Bool
        let due: String
        let icon: String
        let color: String?
    }
    struct Todo: Decodable, Identifiable {
        let id: String
        let text: String
        let date: String?
        let time: String?
        let shared: Bool?
    }
    struct Words: Decodable {
        let spend, income, bills, todos, noBills, noTodos, today, tomorrow, late, inDays, needsAmount, open: String
    }
    let lang: String
    let words: Words
    let monthLabel: String
    let expense: Double
    let income: Double
    let currency: String
    let bills: [Bill]
    let todos: [Todo]
    let accent: String?
    let signedIn: Bool?

    static func load() -> Snapshot? {
        guard let json = UserDefaults(suiteName: "group.app.centel")?.string(forKey: "snapshot"),
              let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(Snapshot.self, from: data)
    }

    static let thaiWords = Words(spend: "ใช้จ่ายเดือนนี้", income: "รายรับ", bills: "บิลที่ใกล้ถึง", todos: "สิ่งที่ต้องทำ",
                                 noBills: "ไม่มีบิลค้างจ่าย", noTodos: "ไม่มีสิ่งที่ต้องทำ", today: "วันนี้", tomorrow: "พรุ่งนี้",
                                 late: "เลยกำหนด", inDays: "อีก {0} วัน", needsAmount: "ระบุยอด", open: "เปิด Centel เพื่ออัปเดต")
    static let sample = Snapshot(
        lang: "th", words: thaiWords, monthLabel: "พฤศจิกายน 2569", expense: 18450, income: 42000, currency: "฿",
        bills: [
            .init(id: "1", name: "ค่าไฟ", amount: 1240, needsAmount: false, autopay: false, due: Day.string(Day.add(Date(), 1)), icon: "⚡", color: "#f5a623"),
            .init(id: "2", name: "บัตรเครดิต KBank", amount: 8900, needsAmount: false, autopay: false, due: Day.string(Day.add(Date(), 4)), icon: "💳", color: "#4a90e2"),
            .init(id: "3", name: "อินเทอร์เน็ต", amount: 599, needsAmount: false, autopay: true, due: Day.string(Day.add(Date(), 9)), icon: "🌐", color: "#7ed321"),
        ],
        todos: [
            .init(id: "a", text: "ไปเยี่ยมแม่ ลำพูน", date: Day.string(Date()), time: "10:00", shared: true),
            .init(id: "b", text: "ต่อประกันรถ", date: Day.string(Day.add(Date(), 3)), time: nil, shared: false),
        ],
        accent: "#ff7a00", signedIn: true)
}

enum Day {
    static let cal = Calendar(identifier: .gregorian)
    static func parse(_ s: String?) -> Date? {
        guard let s = s else { return nil }
        let p = s.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        return cal.date(from: DateComponents(year: p[0], month: p[1], day: p[2]))
    }
    static func string(_ d: Date) -> String {
        let c = cal.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
    static func add(_ d: Date, _ n: Int) -> Date { cal.date(byAdding: .day, value: n, to: d) ?? d }
    static func between(_ from: Date, _ to: Date) -> Int {
        cal.dateComponents([.day], from: cal.startOfDay(for: from), to: cal.startOfDay(for: to)).day ?? 0
    }
}

extension Snapshot {
    func money(_ n: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = n.rounded() == n ? 0 : 2
        f.minimumFractionDigits = f.maximumFractionDigits
        return currency + (f.string(from: NSNumber(value: n)) ?? String(Int(n)))
    }
    // "วันนี้", "พรุ่งนี้", "อีก 3 วัน", "เลยกำหนด", or a short date further out.
    func when(_ due: String, on now: Date) -> (text: String, urgent: Bool) {
        guard let d = Day.parse(due) else { return (due, false) }
        let n = Day.between(now, d)
        if n < 0 { return (words.late, true) }
        if n == 0 { return (words.today, true) }
        if n == 1 { return (words.tomorrow, true) }
        if n <= 7 { return (words.inDays.replacingOccurrences(of: "{0}", with: String(n)), false) }
        let f = DateFormatter()
        f.locale = Locale(identifier: lang == "en" ? "en_US" : "th_TH")
        f.setLocalizedDateFormatFromTemplate("d MMM")
        return (f.string(from: d), false)
    }
    func todoWhen(_ t: Todo, on now: Date) -> String? {
        guard let date = t.date else { return nil }
        let w = when(date, on: now).text
        return t.time.map { "\(w) \($0)" } ?? w
    }
    var unpaid: [Bill] { bills.filter { !$0.autopay } }
    var accentColor: Color { Color(hex: accent ?? "") ?? Color(red: 1, green: 0.48, blue: 0) }
}

extension Color {
    init?(hex: String) {
        let s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "# "))
        guard s.count >= 6, let v = UInt32(s.prefix(6), radix: 16) else { return nil }
        self.init(red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }
}

// MARK: - Timeline

struct Entry: TimelineEntry {
    let date: Date
    let snap: Snapshot?
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: Date(), snap: .sample) }
    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(Entry(date: Date(), snap: context.isPreview ? (Snapshot.load() ?? .sample) : Snapshot.load()))
    }
    // The data only changes when the app saves a new snapshot (and asks for a reload), but
    // "today / tomorrow" moves at midnight, so there is an entry for each of the next days.
    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        let snap = Snapshot.load()
        let start = Day.cal.startOfDay(for: Date())
        var entries = [Entry(date: Date(), snap: snap)]
        for i in 1...3 { entries.append(Entry(date: Day.add(start, i), snap: snap)) }
        completion(Timeline(entries: entries, policy: .atEnd))
    }
}

// MARK: - Views

struct BillRow: View {
    let bill: Snapshot.Bill
    let snap: Snapshot
    let now: Date
    var body: some View {
        let w = snap.when(bill.due, on: now)
        HStack(spacing: 8) {
            Text(bill.icon)
                .font(.system(size: 13))
                .frame(width: 24, height: 24)
                .background(Circle().fill((Color(hex: bill.color ?? "") ?? .gray).opacity(0.22)))
            VStack(alignment: .leading, spacing: 0) {
                Text(bill.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Text(w.text).font(.system(size: 11)).foregroundStyle(w.urgent ? Color.red : Color.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            Text(bill.needsAmount ? snap.words.needsAmount : snap.money(bill.amount))
                .font(.system(size: 13, weight: .semibold)).monospacedDigit().lineLimit(1)
                .foregroundStyle(bill.needsAmount ? Color.secondary : Color.primary)
        }
    }
}

struct TodoRow: View {
    let todo: Snapshot.Todo
    let snap: Snapshot
    let now: Date
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Image(systemName: "circle").font(.system(size: 11)).foregroundStyle(snap.accentColor)
            VStack(alignment: .leading, spacing: 0) {
                Text(todo.text).font(.system(size: 13, weight: .medium)).lineLimit(1)
                if let w = snap.todoWhen(todo, on: now) {
                    Text(w).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
    }
}

struct SpendHeader: View {
    let snap: Snapshot
    var big = false
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(snap.words.spend).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary).lineLimit(1)
            Text(snap.money(snap.expense))
                .font(.system(size: big ? 26 : 22, weight: .bold, design: .rounded))
                .monospacedDigit().minimumScaleFactor(0.6).lineLimit(1)
            Text(snap.monthLabel).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
        }
    }
}

struct EmptyState: View {
    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "c.circle.fill").font(.system(size: 28)).foregroundStyle(Color(red: 1, green: 0.48, blue: 0))
            Text("เปิด Centel เพื่ออัปเดต").font(.system(size: 12)).multilineTextAlignment(.center).foregroundStyle(.secondary)
        }
    }
}

struct SectionTitle: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text).font(.system(size: 11, weight: .semibold)).foregroundStyle(color).textCase(.uppercase).lineLimit(1)
    }
}

struct OverviewView: View {
    @Environment(\.widgetFamily) var family
    let entry: Entry

    var body: some View {
        if let snap = entry.snap { content(snap) } else { EmptyState() }
    }

    @ViewBuilder func content(_ snap: Snapshot) -> some View {
        let bills = snap.unpaid
        switch family {
        case .accessoryInline:
            if let b = bills.first { Text("\(b.icon) \(b.name) · \(snap.when(b.due, on: entry.date).text)") }
            else { Text("\(snap.words.spend) \(snap.money(snap.expense))") }
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Text("\(snap.words.spend) \(snap.money(snap.expense))").font(.system(size: 12, weight: .semibold)).lineLimit(1)
                ForEach(bills.prefix(2)) { b in
                    Text("\(b.name) · \(snap.when(b.due, on: entry.date).text)").font(.system(size: 12)).lineLimit(1)
                }
            }
        case .systemSmall:
            VStack(alignment: .leading, spacing: 6) {
                SpendHeader(snap: snap)
                Spacer(minLength: 0)
                if let b = bills.first {
                    let w = snap.when(b.due, on: entry.date)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("\(b.icon) \(b.name)").font(.system(size: 12, weight: .semibold)).lineLimit(1)
                        Text("\(b.needsAmount ? snap.words.needsAmount : snap.money(b.amount)) · \(w.text)")
                            .font(.system(size: 11)).foregroundStyle(w.urgent ? Color.red : Color.secondary).lineLimit(1)
                    }
                } else {
                    Text(snap.words.noBills).font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .widgetURL(URL(string: "centel://bills"))
        case .systemLarge:
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top) {
                    SpendHeader(snap: snap, big: true)
                    Spacer()
                    VStack(alignment: .trailing, spacing: 1) {
                        Text(snap.words.income).font(.system(size: 11)).foregroundStyle(.secondary)
                        Text(snap.money(snap.income)).font(.system(size: 13, weight: .semibold)).monospacedDigit().foregroundStyle(.green)
                    }
                }
                Link(destination: URL(string: "centel://bills")!) {
                    VStack(alignment: .leading, spacing: 6) {
                        SectionTitle(text: snap.words.bills, color: snap.accentColor)
                        if bills.isEmpty { Text(snap.words.noBills).font(.system(size: 12)).foregroundStyle(.secondary) }
                        ForEach(bills.prefix(4)) { BillRow(bill: $0, snap: snap, now: entry.date) }
                    }
                }
                Divider()
                Link(destination: URL(string: "centel://todos")!) {
                    VStack(alignment: .leading, spacing: 6) {
                        SectionTitle(text: snap.words.todos, color: snap.accentColor)
                        if snap.todos.isEmpty { Text(snap.words.noTodos).font(.system(size: 12)).foregroundStyle(.secondary) }
                        ForEach(snap.todos.prefix(3)) { TodoRow(todo: $0, snap: snap, now: entry.date) }
                    }
                }
                Spacer(minLength: 0)
            }
        default: // .systemMedium
            HStack(alignment: .top, spacing: 12) {
                SpendHeader(snap: snap)
                    .frame(width: 104, alignment: .leading)
                VStack(alignment: .leading, spacing: 6) {
                    SectionTitle(text: snap.words.bills, color: snap.accentColor)
                    if bills.isEmpty { Text(snap.words.noBills).font(.system(size: 12)).foregroundStyle(.secondary) }
                    ForEach(bills.prefix(3)) { BillRow(bill: $0, snap: snap, now: entry.date) }
                    Spacer(minLength: 0)
                }
            }
            .widgetURL(URL(string: "centel://bills"))
        }
    }
}

struct TodoView: View {
    @Environment(\.widgetFamily) var family
    let entry: Entry
    var body: some View {
        if let snap = entry.snap {
            VStack(alignment: .leading, spacing: 6) {
                SectionTitle(text: snap.words.todos, color: snap.accentColor)
                if snap.todos.isEmpty { Text(snap.words.noTodos).font(.system(size: 12)).foregroundStyle(.secondary) }
                ForEach(snap.todos.prefix(family == .systemSmall ? 3 : 4)) { TodoRow(todo: $0, snap: snap, now: entry.date) }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .widgetURL(URL(string: "centel://todos"))
        } else { EmptyState() }
    }
}

// MARK: - Widgets

struct CentelOverviewWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "CentelOverview", provider: Provider()) { entry in
            OverviewView(entry: entry).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Centel")
        .description("ใช้จ่ายเดือนนี้และบิลที่ใกล้ครบกำหนด")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryInline])
    }
}

struct CentelTodoWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "CentelTodos", provider: Provider()) { entry in
            TodoView(entry: entry).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("สิ่งที่ต้องทำ")
        .description("สิ่งที่ต้องทำที่ยังไม่เสร็จ")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct CentelWidgets: WidgetBundle {
    var body: some Widget {
        CentelOverviewWidget()
        CentelTodoWidget()
    }
}
