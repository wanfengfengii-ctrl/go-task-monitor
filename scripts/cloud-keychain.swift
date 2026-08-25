import Foundation
import Security

private func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(code)
}

guard CommandLine.arguments.count == 4 else {
    fail("usage: cloud-keychain <store|read|exists|delete> <service> <account>", code: 64)
}

let action = CommandLine.arguments[1]
let service = CommandLine.arguments[2]
let account = CommandLine.arguments[3]
let baseQuery: [CFString: Any] = [
    kSecClass: kSecClassGenericPassword,
    kSecAttrService: service,
    kSecAttrAccount: account,
]

switch action {
case "store":
    let password = FileHandle.standardInput.readDataToEndOfFile()
    guard !password.isEmpty else { fail("password is empty", code: 65) }
    var status = SecItemUpdate(
        baseQuery as CFDictionary,
        [kSecValueData: password] as CFDictionary
    )
    if status == errSecItemNotFound {
        var createQuery = baseQuery
        createQuery[kSecValueData] = password
        createQuery[kSecAttrLabel] = "Go Task Monitor cloud auto-login"
        createQuery[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlock
        status = SecItemAdd(createQuery as CFDictionary, nil)
    }
    guard status == errSecSuccess else { fail("keychain store failed: \(status)") }

case "read":
    var readQuery = baseQuery
    readQuery[kSecMatchLimit] = kSecMatchLimitOne
    readQuery[kSecReturnData] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(readQuery as CFDictionary, &result)
    if status == errSecItemNotFound { exit(2) }
    guard status == errSecSuccess, let password = result as? Data else {
        fail("keychain read failed: \(status)")
    }
    FileHandle.standardOutput.write(password)

case "exists":
    var existsQuery = baseQuery
    existsQuery[kSecMatchLimit] = kSecMatchLimitOne
    let status = SecItemCopyMatching(existsQuery as CFDictionary, nil)
    if status == errSecItemNotFound { exit(2) }
    guard status == errSecSuccess else { fail("keychain lookup failed: \(status)") }

case "delete":
    let status = SecItemDelete(baseQuery as CFDictionary)
    if status == errSecItemNotFound { exit(0) }
    guard status == errSecSuccess else { fail("keychain delete failed: \(status)") }

default:
    fail("unsupported action: \(action)", code: 64)
}
