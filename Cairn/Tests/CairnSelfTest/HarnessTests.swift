import Foundation

let harnessTests: [TestCase] = {
    var t = [
        TestCase("assertions_pass") {
            try expect(1 + 1 == 2)
            try expectEqual("a", "a")
        },
        TestCase("failure_is_reported") {
            // Un test qui échoue doit lever une erreur : on le vérifie sans faire échouer la suite.
            var caught = false
            do { try expectEqual(1, 2) } catch { caught = true }
            try expect(caught, "expectEqual(1, 2) aurait dû échouer")
        },
    ]
    // Démonstration volontaire d'échec : CAIRN_SELFTEST_FAIL_DEMO=1 just test → code de sortie 1.
    if ProcessInfo.processInfo.environment["CAIRN_SELFTEST_FAIL_DEMO"] == "1" {
        t.append(TestCase("deliberate_failure") { try expectEqual(1, 2, "échec volontaire") })
    }
    return t
}()
