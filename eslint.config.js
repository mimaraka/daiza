import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      reactRefresh.configs.vite,
    ],
    // eslint-plugin-react-hooks@7 の recommended-latest は plugins を文字列配列で返し、
    // ESLint 10 のフラットコンフィグでは無効なため、プラグインは自前でオブジェクト登録し
    // ルールのみを取り込む。
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      // any禁止（SPEC要件）。やむを得ない場合のみ個別に無効化する運用とする。
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  // Prettierと競合する整形系ルールを無効化（必ず最後）。
  prettier,
);
