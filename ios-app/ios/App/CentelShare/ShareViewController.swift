import UIKit
import ImageIO
import UniformTypeIdentifiers

// "Centel" in the iOS share sheet: a screenshot (or any photo) shared to Centel becomes a new
// purchase. The picture is shrunk, kept in the App Group's Inbox folder and the app is opened at
// centel://share; the page (share.js) takes it from there with the ShareInbox plugin, reads it
// with AI Slips and shows the filled-in transaction to confirm.
// If iOS does not let the app open, the picture waits in the Inbox and is picked up the next
// time Centel comes to the front.
class ShareViewController: UIViewController {
    static let group = "group.app.centel"
    static let maxPixels: CGFloat = 2200

    private let card = UIView()
    private let label = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var started = false

    private var thai: Bool { (Locale.preferredLanguages.first ?? "").hasPrefix("th") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black.withAlphaComponent(0.25)
        card.backgroundColor = .secondarySystemBackground
        card.layer.cornerRadius = 22
        card.translatesAutoresizingMaskIntoConstraints = false
        label.text = thai ? "กำลังส่งไป Centel…" : "Sending to Centel…"
        label.font = .preferredFont(forTextStyle: .headline)
        label.numberOfLines = 0
        label.textAlignment = .center
        let stack = UIStackView(arrangedSubviews: [spinner, label])
        stack.axis = .vertical
        stack.spacing = 12
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)
        view.addSubview(card)
        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.widthAnchor.constraint(equalToConstant: 260),
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -20),
        ])
        spinner.startAnimating()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        loadImage { [weak self] data in
            DispatchQueue.main.async { self?.finish(data) }
        }
    }

    // The first image among the shared items, as JPEG data no bigger than maxPixels on its long side.
    private func loadImage(_ done: @escaping (Data?) -> Void) {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let provider = items.flatMap { $0.attachments ?? [] }
            .first { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        guard let provider else { return done(nil) }
        provider.loadItem(forTypeIdentifier: UTType.image.identifier, options: nil) { item, _ in
            var source: CGImageSource?
            if let url = item as? URL {
                source = CGImageSourceCreateWithURL(url as CFURL, nil)
            } else if let data = item as? Data {
                source = CGImageSourceCreateWithData(data as CFData, nil)
            } else if let image = item as? UIImage, let data = image.pngData() {
                source = CGImageSourceCreateWithData(data as CFData, nil)
            }
            guard let source else { return done(nil) }
            let opts: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: Self.maxPixels,
            ]
            guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, opts as CFDictionary) else { return done(nil) }
            done(UIImage(cgImage: cg).jpegData(compressionQuality: 0.85))
        }
    }

    private func finish(_ data: Data?) {
        guard let data, let dir = Self.inbox() else {
            return fail(thai ? "ส่งรูปนี้ไม่ได้ ลองแคปหน้าจอใหม่อีกครั้ง" : "Couldn't send this picture. Try another screenshot.")
        }
        let file = dir.appendingPathComponent("\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.prefix(8)).jpg")
        do { try data.write(to: file, options: .atomic) } catch {
            return fail(thai ? "บันทึกรูปไม่สำเร็จ" : "Couldn't save the picture.")
        }
        if openApp(URL(string: "centel://share")!) {
            extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
        } else {
            // iOS did not let us open the app: the picture waits in the Inbox.
            fail(thai ? "ส่งแล้ว เปิด Centel เพื่อยืนยันรายการ" : "Sent. Open Centel to confirm the purchase.", done: true)
        }
    }

    private func fail(_ text: String, done: Bool = false) {
        spinner.stopAnimating()
        spinner.isHidden = true
        label.text = text
        DispatchQueue.main.asyncAfter(deadline: .now() + (done ? 1.6 : 2.2)) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
        }
    }

    // A share extension has no UIApplication.shared, but the app object is at the end of the
    // responder chain once this view is on screen.
    private func openApp(_ url: URL) -> Bool {
        var r: UIResponder? = self
        while let x = r {
            if let app = x as? UIApplication {
                app.open(url, options: [:], completionHandler: nil)
                return true
            }
            r = x.next
        }
        return false
    }

    static func inbox() -> URL? {
        guard let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        let dir = base.appendingPathComponent("Inbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}
