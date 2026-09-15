import typescriptEslint from "typescript-eslint";

const terminalSelectors = [{
    selector: "CallExpression[callee.property.name='createTerminal']",
    message: "Запускайте команды задачей через createVRunnerTask: терминалу нужен ConPTY, его нет на Windows старее 1809. Терминал допустим только в ветке execution.useTasks === false, с eslint-disable и пояснением.",
}, {
    selector: "CallExpression[callee.property.name='sendText']",
    message: "sendText пишет в терминал VS Code. Команду дочернего процесса собирайте через buildProcessCommand и запускайте задачей.",
}];

const firstFolderMessage = "Первая папка рабочей области не обязательно текущий проект. Корень берите через currentRoot() или projectOf(uri) из src/shared/workspaceProjects.ts.";

/** Выражения, которые дают папки рабочей области: `workspaceFolders`, `x.workspaceFolders`, `workspaceFolders!`, `(workspaceFolders ?? [])`. */
const foldersPaths = [
    "name='workspaceFolders'",
    "property.name='workspaceFolders'",
    "expression.name='workspaceFolders'",
    "expression.property.name='workspaceFolders'",
    "left.name='workspaceFolders'",
    "left.property.name='workspaceFolders'",
];

const firstFolderSelectors = [
    ...foldersPaths.map((folders) => `MemberExpression[computed=true][property.value=0][object.${folders}]`),
    ...foldersPaths.map((folders) => `CallExpression[callee.property.name='at'][arguments.0.value=0][callee.object.${folders}]`),
    ...foldersPaths.map((folders) => `VariableDeclarator[id.type='ArrayPattern'][init.${folders}]`),
].map((selector) => ({ selector, message: firstFolderMessage }));

export default [{
    files: ["**/*.ts"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint.plugin,
    },

    languageOptions: {
        parser: typescriptEslint.parser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        "@typescript-eslint/no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",

        "no-restricted-syntax": ["error", ...terminalSelectors, ...firstFolderSelectors],
    },
}, {
    // Модуль проектов сам разрешает корень из папок рабочей области
    files: ["src/shared/workspaceProjects.ts"],
    rules: {
        "no-restricted-syntax": ["error", ...terminalSelectors],
    },
}];
