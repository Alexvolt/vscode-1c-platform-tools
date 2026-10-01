# Фикстуры YAxUnit

`*.bsl` в корне — модули тестовых расширений для разбора (`bslTestParser.test.ts`).

`project` и `reports` — проект и jUnit-отчёты YAxUnit 25.12 для прогона из панели тестирования
(`yaxunitRunResults.test.ts`) и разбора отчёта (`yaxunitAdapter.test.ts`, `junitParser.test.ts`).

| Файл | Откуда |
|---|---|
| `project/tests/cfe/yaxunit/Configuration.xml` | `ssl_3_1`: расширение YAXUNIT 25.12 |
| `project/tests/cfe/yaxunit/CommonModules/Док_АктыВыполненныхРабот` | отчёт о баге: тесты с описанием и тегом лежат в самом расширении YAXUNIT, тела процедур пустые |
| `reports/test-presentation.xml` | там же: фрагмент отчёта прогона этого модуля |
| `project/tests/cfe/yaxunit-test` | `ssl_3_1` на коммите `8173a2b1`: расширение «Тесты», из модулей только `Module.bsl` |
| `reports/ssl31.xml` | `ssl_3_1/build/out/yaxunit/junit.xml`: прогон расширения «Тесты» |
| `project/src/cfe/_ДемоПустоеРасширение` | `ssl_3_1`: описание расширения и копия модуля `ОМ_Тест_Арифметика` — тот же модуль в другом расширении |

## Регенерация

Модули «Тесты» и `ssl31.xml` снимаются с одного прогона `ssl_3_1`: загрузить тестовые расширения
в базу, выполнить YAxUnit с отчётом jUnit (`tools/yaxunit.json`) и скопировать из корня репозитория:

```powershell
$ssl = "../ssl_3_1"
$fx = "src/test/fixtures/yaxunit"
Copy-Item "$ssl/build/out/yaxunit/junit.xml" "$fx/reports/ssl31.xml"
Get-ChildItem "$fx/project/tests/cfe/yaxunit-test/CommonModules" -Directory | ForEach-Object {
	Copy-Item "$ssl/tests/cfe/yaxunit-test/CommonModules/$($_.Name)/Ext/Module.bsl" "$($_.FullName)/Ext/Module.bsl"
}
Copy-Item "$fx/project/tests/cfe/yaxunit-test/CommonModules/ОМ_Тест_Арифметика/Ext/Module.bsl" `
	"$fx/project/src/cfe/_ДемоПустоеРасширение/CommonModules/ОМ_Тест_Арифметика/Ext/Module.bsl"
```

После регенерации сверьте ожидаемые статусы в `yaxunitRunResults.test.ts` с отчётом.
