import { findParentVariableDeclaration } from './recast-helpers';

export function addRequireOrImport(j, ast, localName, pkg) {
    const { statement } = j.template;

    const requires = ast.find(j.CallExpression, {
        callee: { name: 'require' },
    });

    let requireStatement;
    if (requires.size()) {
        requireStatement = statement`const ${localName} = require(${j.literal(pkg)});`;
    } else {
        requireStatement = j.importDeclaration(
            [j.importDefaultSpecifier(j.identifier(localName))],
            j.literal(pkg)
        );
    }

    ast
        .find(j.Program)
        .get('body', 0)
        .insertBefore(requireStatement);
}

export function addRequireOrImportOnceFactory(j, ast) {
    const pkgs = new Set([]);
    return (localName, pkg) => {
        if (!pkgs.has(pkg)) {
            addRequireOrImport(j, ast, localName, pkg);
            pkgs.add(pkg);
        }
    };
}

export function findRequires(j, ast, pkg) {
    return ast
        .find(j.CallExpression, {
            callee: { name: 'require' },
            arguments: arg => arg[0].value === pkg,
        })
        .filter(p => p.value.arguments.length === 1);
}

export function findImports(j, ast, pkg) {
    return ast.find(j.ImportDeclaration, {
        source: {
            value: pkg,
        },
    });
}

/**
 * Detects CommonJS and import statements for the given package.
 * @return true if import were found, else false
 */
export function hasRequireOrImport(j, ast, pkg) {
    const requires = findRequires(j, ast, pkg).size();
    const imports = findImports(j, ast, pkg).size();
    return requires + imports > 0;
}

function findParentPathMemberRequire(path) {
    if (path.parentPath && path.parentPath.value.type === 'MemberExpression') {
        return path.parentPath.value.property;
    }
    return null;
}

/**
 * Returns localName for any CommonJS or import statements for the given package.
 * @return string if import were found, else undefined
 */
export function getRequireOrImportName(j, ast, pkg) {
    let localName = null;
    findRequires(j, ast, pkg).forEach(p => {
        const variableDeclarationPath = findParentVariableDeclaration(p);
        if (variableDeclarationPath) {
            localName = variableDeclarationPath.value.id.name;
        }
    });

    findImports(j, ast, pkg).forEach(p => {
        const pathSpecifier = p.value.specifiers[0];
        if (pathSpecifier && pathSpecifier.type === 'ImportDefaultSpecifier') {
            localName = pathSpecifier.local.name;
        }
    });

    return localName;
}

/**
 * Detects and removes default import statements for given package.
 * @return the local name for the default import or null
 */
export function removeDefaultImport(j, ast, pkg) {
    const getBodyNode = () => ast.find(j.Program).get('body', 0).node;
    const { comments } = getBodyNode(j, ast);

    let localName = null;
    findImports(j, ast, pkg).forEach(p => {
        const pathSpecifier = p.value.specifiers[0];
        if (pathSpecifier && pathSpecifier.type === 'ImportDefaultSpecifier') {
            localName = pathSpecifier.local.name;
            p.prune();
        }
    });

    getBodyNode(j, ast).comments = comments;

    return localName;
}

/**
 * Detects and removes CommonJS and import statements for given package.
 * @return the import variable name or null if no import were found.
 */
export function removeRequireAndImport(j, ast, pkg, specifier) {
    const getBodyNode = () => ast.find(j.Program).get('body', 0).node;
    const { comments } = getBodyNode(j, ast);

    let localName = null;
    let importName = null;
    findRequires(j, ast, pkg).forEach(p => {
        const variableDeclarationPath = findParentVariableDeclaration(p);
        const parentMember = findParentPathMemberRequire(p);

        // Examples:
        //   const chai = require('chai');
        //   const expect = require('chai').expect;
        if (!specifier || (parentMember && parentMember.name === specifier)) {
            if (variableDeclarationPath) {
                localName = variableDeclarationPath.value.id.name;
                variableDeclarationPath.prune();
            } else {
                p.prune();
            }
        }

        // Examples:
        //   const { expect } = require('chai');
        //   const { expect: expct } = require('chai');
        if (
            specifier &&
            variableDeclarationPath &&
            variableDeclarationPath.value &&
            variableDeclarationPath.value.id.type === 'ObjectPattern'
        ) {
            const { properties } = variableDeclarationPath.value.id;

            const index = properties.findIndex(prop => {
                return prop.key.type === 'Identifier' && prop.key.name === specifier;
            });

            if (index !== undefined) {
                const propertyPath = variableDeclarationPath.get(
                    'id',
                    'properties',
                    index
                );

                localName = propertyPath.value.value.name;

                if (properties.length === 1) {
                    // Remove the variable declaration if there's only one property
                    // e.g. const { expect } = require('chai');
                    variableDeclarationPath.prune();
                } else {
                    // Only remove the property if other properties exist
                    // e.g. const { expect, other } = require('chai');
                    propertyPath.prune();
                }
            }
        }
    });

    findImports(j, ast, pkg).forEach(p => {
        const pathSpecifier = p.value.specifiers[0];
        importName =
            pathSpecifier && pathSpecifier.imported && pathSpecifier.imported.name;

        if (!specifier || importName === specifier) {
            if (pathSpecifier) {
                localName = pathSpecifier.local.name;
            }
            p.prune();
        }
    });

    getBodyNode(j, ast).comments = comments;

    return localName;
}
